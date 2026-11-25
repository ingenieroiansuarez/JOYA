# Command Center / CRM / ERP / POS
Single organization with multiple branches, warehouses, vaults and workshops. All records scoped by organization/location and resource; users may have multiple roles. Operational ERP not certified tax accounting.

| Module | Workflow / screen capabilities | Controls |
|---|---|---|
| Executive | configurable KPIs, comparisons, alerts, business copilot | date/branch/currency filters; define sales net vs gross, gross margin, WIP, receivables |
| CRM | customer profile, lead → design → quote → negotiation → sale; tasks, notes, consent, appointments | omnichannel metadata, chat/files/voice/video/calendar adapters, WhatsApp link or authorized API; no scraping |
| Catalog | drafts, review, publish, SKU/collection, price/asset, import CSV/Excel preview | validation, duplicates, license, rollback via version |
| Procurement | supplier RFQ → PO → partial receipt → reconcile, outsource job | scope external files, no margin/PII, discrepancy and return |
| Inventory | lots/metals, unique stones, SKU, consumables, customer property, WIP, recovered gold | ledger, dual approval threshold, actual vs expected mass |
| Custody | sender handoff → receiver confirmation, QR/barcode | evidence, current custodian/location, discrepancy; labels contain opaque ID only |
| Finance | estimates vs actuals, receivables/payables, deposits, commissions, refunds, reconciliation, accounting export | immutable ledger, corrections reversing entries; currency per transaction, approved export mapping |
| POS | session opening, sale, mixed payments, receipt, refund, close cash, discrepancy | stock locks, fiscal adapter, operator and cash drawer audit; no offline payments without approved provider |
| Showroom | full-screen 3D, assisted project, transfer invite | customer claims with consent, no exposing private previous projects |
| Marketing | creative studio, assets, campaign drafts, segment, approval, metrics | consent, truthful product depiction, no auto-publish |
| Aftercare | warranty, intake, repairs, sizing, maintenance, appraisal, return | custody, evidence, customer approvals |
| Equipment | asset, preventive schedule, service, breakdown, usage cost | block unavailable resource on planning; no direct machine control |
| Configuration | onboarding, imports, locations, rules, theme, roles, notifications | review sample, dry-run, import error report, permissions |

KPIs: gross margin=(net sales-direct cost)/net sales; net sales excludes taxes and returns per policy. Cost variance=actual−estimated; quote conversion accepted/issued by cohort; lead time median from release→QA; inventory valuation approved accounting policy, not market price automatically. Business Copilot read-only metrics with data source/time/filters and permission. Alerts route to authorized role; dedup and escalation; no sensitive lock-screen content. Multi-location transfer under two-step receipt; accounting adapter exports immutable batch hash with reconciliation totals.
