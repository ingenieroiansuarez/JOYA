import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { ApiError } from "../api";
import { CommerceClient, type Quote } from "../commerce/client";
import { FamilyArt } from "../design/art";
import { useDesign } from "../design/DesignContext";
import { familyName } from "../design/describe";
import { waitForJob } from "../design/glb";
import { formatMoney } from "../format";
import { useSession } from "../session";
import { Button, c, errorKey, Header, Loading, Notice, styles } from "../ui";
import { Card, Journey, qs, quoteStep, Row, Status, Total } from "./commerce-ui";

// The pilot's only enabled currency (pricing rules are COP); the API refuses any other.
const CURRENCY = "COP";


type State =
  | { phase: "requesting" }
  | { phase: "building" } // the revision has no geometry yet: built first, then priced
  | { phase: "blocked"; code: string } // DFM_BLOCKED or another refusal a retry will not fix
  | { phase: "error"; error: ApiError | null }
  | { phase: "quote"; quote: Quote };

/**
 * Request → wait for the advisor → accept. The price is the server's (never computed here); accepting
 * binds the exact issued digest and terms the customer is looking at.
 */
export function QuoteScreen({ revisionId, onBack, onOrder, pollMs = 5_000 }: { revisionId: string; onBack: () => void; onOrder: (orderId: string) => void; pollMs?: number }) {
  const { t, locale, api, withToken } = useSession();
  const { client, newId, saw, store } = useDesign();
  const commerce = useMemo(() => new CommerceClient(api, withToken), [api, withToken]);
  const [state, setState] = useState<State>({ phase: "requesting" });
  const [accepting, setAccepting] = useState<"idle" | "busy" | ApiError>("idle");
  // Keys survive retries of the same intent (a lost answer must not create a second quote or order).
  const requestKey = useRef(newId());
  const acceptKey = useRef(newId());
  const alive = useRef({ aborted: false });
  useEffect(() => () => { alive.current.aborted = true; }, []);

  const request = useCallback(async (fresh = false) => {
    if (fresh) requestKey.current = newId();
    setState({ phase: "requesting" });
    try {
      try {
        setState({ phase: "quote", quote: await commerce.requestQuote(revisionId, CURRENCY, requestKey.current) });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "GEOMETRY_REQUIRED") throw e;
        setState({ phase: "building" });
        const job = await waitForJob(client, (await client.buildRevision(revisionId, newId())).id, { signal: alive.current });
        if (job.state !== "SUCCEEDED") { setState({ phase: "blocked", code: job.errorCode ?? "GEOMETRY_FAILED" }); return; }
        requestKey.current = newId(); // the first attempt was refused, so nothing to replay
        setState({ phase: "quote", quote: await commerce.requestQuote(revisionId, CURRENCY, requestKey.current) });
      }
      saw(undefined);
    } catch (e) {
      if (alive.current.aborted) return;
      saw(e);
      const err = e instanceof ApiError ? e : null;
      if (err && (err.kind === "rejected" || err.kind === "forbidden" || err.kind === "notFound")) setState({ phase: "blocked", code: err.code ?? err.kind });
      else setState({ phase: "error", error: err });
    }
  }, [commerce, client, revisionId, newId, saw]);
  useEffect(() => { void request(); }, [request]);

  // The design's family and alloy from what the phone already has, for the picture at the top.
  const projectId = state.phase === "quote" ? state.quote.projectId : null;
  const [piece, setPiece] = useState<{ familyId: string; materialId: string } | null>(null);
  useEffect(() => {
    if (!projectId || !store) return;
    void store.project(projectId).then((p) => {
      if (p && !alive.current.aborted) setPiece({ familyId: p.project.familyId, materialId: p.head.document.components[0]?.materialId ?? "" });
    }).catch(() => undefined);
  }, [projectId, store]);

  // While the advisor reviews (DRAFT), look again every few seconds; stop once there is an answer.
  const quoteId = state.phase === "quote" ? state.quote.id : null;
  const waiting = state.phase === "quote" && state.quote.state === "DRAFT";
  useEffect(() => {
    if (!quoteId || !waiting) return;
    const timer = setInterval(() => {
      commerce.getQuote(quoteId).then((q) => { saw(undefined); setState({ phase: "quote", quote: q }); }).catch(saw);
    }, pollMs);
    return () => clearInterval(timer);
  }, [commerce, quoteId, waiting, saw, pollMs]);

  const accept = async (q: Quote) => {
    setAccepting("busy");
    try {
      const order = await commerce.acceptQuote(q, acceptKey.current);
      saw(undefined);
      setAccepting("idle");
      onOrder(order.id);
    } catch (e) {
      saw(e);
      const err = e instanceof ApiError ? e : new ApiError("unexpected");
      setAccepting(err);
      if (err.code === "QUOTE_EXPIRED" || err.code === "DIGEST_MISMATCH") {
        commerce.getQuote(q.id).then((fresh) => setState({ phase: "quote", quote: fresh })).catch(() => undefined);
      }
    }
  };

  const header = <Header title={t("quoteTitle")} onBack={onBack} backLabel={t("back")} />;
  if (state.phase === "requesting") return <View style={styles.screen}>{header}<Loading label={t("quoteRequesting")} /></View>;
  if (state.phase === "building") return <View style={styles.screen}>{header}<Loading label={t("quoteBuilding")} /></View>;
  if (state.phase === "blocked") {
    return <View style={styles.screen}>{header}<Notice alert message={state.code === "DFM_BLOCKED" ? t("quoteDfmBlocked") : t("quoteRefused", { code: state.code })} action={{ label: t("back"), onPress: onBack }} /></View>;
  }
  if (state.phase === "error") {
    return <View style={styles.screen}>{header}<Notice alert message={t(errorKey(state.error))} action={{ label: t("retry"), onPress: () => void request() }} /></View>;
  }

  const q = state.quote;
  const m = (x: { amount: string; currency: string }) => formatMoney(x.amount, x.currency, locale);
  const acceptError = accepting instanceof ApiError ? accepting : null;
  const step = quoteStep(q.state);
  const tone = q.state === "ISSUED" ? "success" : q.state === "DRAFT" || q.state === "ACCEPTED" ? "accent" : "warning";
  return (
    <View style={styles.screen}>
      <Header overline={t("quoteTitle")} title={q.projectTitle} subtitle={t("revisionLine", { number: String(q.revisionNumber) })} onBack={onBack} backLabel={t("back")} />
      <ScrollView contentContainerStyle={qs.content}>
        {piece && (
          <View style={qs.hero}>
            <FamilyArt familyId={piece.familyId} materialId={piece.materialId} label="" style={qs.heroArt} />
            <View style={qs.heroBody}>
              <Text style={styles.muted}>{familyName(piece.familyId, locale)}</Text>
              <Status text={t(`quoteState_${q.state}`)} tone={tone} />
            </View>
          </View>
        )}
        {!piece && <Status text={t(`quoteState_${q.state}`)} tone={tone} />}
        {step !== null && <Journey current={step} t={t} />}
        {q.pricing.simulated && <Text style={[styles.muted, { color: c.warning }]}>{t("quoteSimulated")}</Text>}
        <Card title={t("quoteBreakdown")}>
          {q.lines.map((l) => <Row key={l.code} k={l.label} v={m(l.amount)} />)}
          <Row k={t("quoteSubtotal")} v={m(q.subtotal)} />
          <Row k={t("quoteTax", { rate: pct(q.tax.rate) })} v={m(q.tax.amount)} />
          <Total k={t("quoteTotal")} v={m(q.total)} />
          <Row k={t("quoteDeposit", { rate: pct(q.deposit.rate) })} v={m(q.deposit.amount)} />
        </Card>
        {q.state === "DRAFT" && <Text style={styles.muted}>{t("quoteDraftNote")}</Text>}
        {q.state === "ISSUED" && (
          <>
            <Text style={styles.muted}>{t("quoteValidUntil", { date: day(q.expiresAt, locale) })}</Text>
            <Text style={styles.muted}>{t("quoteAcceptNote", { deposit: m(q.deposit.amount) })}</Text>
            <Button label={accepting === "busy" ? t("quoteAccepting") : t("quoteAccept")} disabled={accepting === "busy"} onPress={() => void accept(q)} />
          </>
        )}
        {acceptError && (
          <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
            {acceptError.code === "INSUFFICIENT_STOCK" ? t("quoteNoStock") : acceptError.code === "QUOTE_EXPIRED" ? t("quoteExpiredNow")
              : acceptError.kind === "offline" ? t("errorOffline") : t("quoteAcceptFailed")}
          </Text>
        )}
        {(q.state === "EXPIRED" || q.state === "REJECTED" || q.state === "SUPERSEDED") && (
          <Button label={t("quoteAskAgain")} onPress={() => void request(true)} />
        )}
        {q.state === "ACCEPTED" && q.orderId && <Button label={t("quoteSeeOrder")} onPress={() => onOrder(q.orderId!)} />}
      </ScrollView>
    </View>
  );
}

const pct = (rate: string) => `${(Number(rate) * 100).toFixed(0)} %`; // display of a configured rate, not money
const day = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-CO", { dateStyle: "long", timeZone: "America/Bogota" }).format(new Date(iso));
