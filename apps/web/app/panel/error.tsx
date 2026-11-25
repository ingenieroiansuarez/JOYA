"use client";

/** Unexpected failure while rendering a panel page. Bilingual on purpose: client components have no catalog here. */
export default function PanelError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="notice notice-danger">
      <p>No se pudo cargar esta sección. / This section could not be loaded.</p>
      <button type="button" onClick={reset}>Reintentar / Retry</button>
    </div>
  );
}
