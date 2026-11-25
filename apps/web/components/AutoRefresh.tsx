"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Re-fetches the server-rendered panel every few seconds so a quote requested on the phone (or a
 * simulated payment) shows up without a reload. Paused while hidden, offline, or while someone is
 * typing in a field.
 */
export function AutoRefresh({ seconds = 5, offlineLabel, liveLabel }: { seconds?: number; offlineLabel: string; liveLabel: string }) {
  const router = useRouter();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const id = window.setInterval(() => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
      if (document.visibilityState === "visible" && navigator.onLine && !typing) router.refresh();
    }, seconds * 1000);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [router, seconds]);
  return online
    ? <p className="live" aria-live="polite">{liveLabel}</p>
    : <p className="notice notice-warning" role="status">{offlineLabel}</p>;
}
