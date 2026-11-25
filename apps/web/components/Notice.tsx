/** Result of the last action, from the query string. Error text is the API's own (already localized). */
export function Notice({ ok, error, detail }: { ok?: string; error?: string; detail?: string }) {
  if (error) return <p role="alert" className="notice notice-danger">{detail || error}</p>;
  if (ok) return <p role="status" className="notice notice-success">{ok}</p>;
  return null;
}
