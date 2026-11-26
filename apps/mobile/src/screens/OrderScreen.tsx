import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ApiError } from "../api";
import { CommerceClient, openDeposit, type Order } from "../commerce/client";
import { useDesign } from "../design/DesignContext";
import { formatDecimal, formatMoney } from "../format";
import { useSession } from "../session";
import { Button, c, errorKey, Header, Loading, Notice, styles } from "../ui";
import { Card, Journey, orderStep, qs, Row, Status, Total } from "./commerce-ui";



/**
 * The order after acceptance: what is owed, the metal held for it, and the simulated deposit. The app
 * never marks anything paid: it asks the API, which confirms only from a verified provider event.
 */
export function OrderScreen({ id, onBack, pollMs = 5_000 }: { id: string; onBack: () => void; pollMs?: number }) {
  const { t, locale, api, withToken } = useSession();
  const { newId, saw } = useDesign();
  const commerce = useMemo(() => new CommerceClient(api, withToken), [api, withToken]);
  const [order, setOrder] = useState<Order | null | ApiError>(null);
  const [paying, setPaying] = useState<"idle" | "busy" | ApiError>("idle");
  // One key per payment attempt, kept across retries of that attempt.
  const attempt = useRef<{ intent: string; simulate: string } | null>(null);

  const load = useCallback(async () => {
    try { setOrder(await commerce.getOrder(id)); saw(undefined); } catch (e) { saw(e); setOrder((o) => (o && !(o instanceof ApiError) ? o : e instanceof ApiError ? e : new ApiError("unexpected"))); }
  }, [commerce, id, saw]);
  useEffect(() => { void load(); }, [load]);

  const pending = order && !(order instanceof ApiError) && order.state === "PENDING_PAYMENT";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [pending, load, pollMs]);

  const pay = async (o: Order) => {
    attempt.current ??= { intent: newId(), simulate: newId() };
    setPaying("busy");
    try {
      const existing = openDeposit(o);
      const payment = existing ?? await commerce.createDeposit(o, attempt.current.intent);
      const done = await commerce.simulate(payment.id, "APPROVE", attempt.current.simulate);
      saw(undefined);
      if (done.state === "FAILED" || done.state === "CONFIRMED") attempt.current = null; // that attempt is over
      setPaying("idle");
      await load();
    } catch (e) {
      saw(e);
      setPaying(e instanceof ApiError ? e : new ApiError("unexpected"));
      await load();
    }
  };

  const header = <Header title={t("orderTitle")} onBack={onBack} backLabel={t("back")} />;
  if (order === null) return <View style={styles.screen}>{header}<Loading label={t("orderLoading")} /></View>;
  if (order instanceof ApiError) {
    return <View style={styles.screen}>{header}<Notice alert message={t(errorKey(order))} action={{ label: t("retry"), onPress: () => { setOrder(null); void load(); } }} /></View>;
  }
  const m = (x: { amount: string; currency: string }) => formatMoney(x.amount, x.currency, locale);
  const review = order.payments.find((p) => p.reviewReason);
  const payError = paying instanceof ApiError ? paying : null;
  const step = orderStep(order.state);
  const tone = order.state === "CONFIRMED" || order.state === "READY" || order.state === "DELIVERED" ? "success" : order.state === "CANCELLED" ? "danger" : "accent";
  const held = order.reservations.filter((v) => v.state !== "RELEASED");
  return (
    <View style={styles.screen}>
      <Header overline={t("orderTitle")} title={order.projectTitle} subtitle={t("revisionLine", { number: String(order.revisionNumber) })} onBack={onBack} backLabel={t("back")} />
      <ScrollView contentContainerStyle={qs.content}>
        <Status text={t(`orderState_${order.state}`)} tone={tone} />
        {order.state === "CONFIRMED" && <Text style={styles.body}>{t("orderConfirmedNote")}</Text>}
        {step !== null && <Journey current={step} t={t} />}
        <Card title={t("orderPayments")}>
          <Total k={t("quoteTotal")} v={m(order.total)} />
          <Row k={t("orderDepositRequired")} v={m(order.deposit.required)} />
          <Row k={t("orderDepositPaid")} v={m(order.deposit.paid)} />
          {Number(order.deposit.outstanding.amount) > 0 && <Row k={t("orderOutstanding")} v={m(order.deposit.outstanding)} />}
          <Row k={t("orderBalance")} v={m(order.balance)} />
        </Card>
        <Card title={t("orderMetal")}>
          {held.length === 0
            ? <Text style={styles.muted}>{t("orderNoMetal")}</Text>
            : held.map((v) => (
              <Row key={v.id} k={v.lotLabel} v={`${formatDecimal(v.quantity, v.unit, locale)} · ${t(v.state === "ALLOCATED" ? "orderMetalAllocated" : "orderMetalHeld")}`} />
            ))}
        </Card>
        {order.state === "PENDING_PAYMENT" && !review && (
          <>
            <Text style={[styles.muted, { color: c.warning }]}>{t("orderSimulatedNote")}</Text>
            <Button label={paying === "busy" ? t("orderPaying") : t("orderPay", { amount: m(order.deposit.outstanding) })} disabled={paying === "busy"} onPress={() => void pay(order)} />
          </>
        )}
        {review && <Text accessibilityRole="alert" style={[styles.body, { color: c.warning }]}>{t("orderReview")}</Text>}
        {payError && (
          <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
            {payError.kind === "offline" ? t("errorOffline") : payError.code === "ALREADY_PAID" ? t("orderAlreadyPaid") : t("orderPayFailed")}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
