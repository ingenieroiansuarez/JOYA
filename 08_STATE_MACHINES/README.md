# State machines
Cada transición se valida en backend con estado actual, permisos, precondiciones, versión esperada y clave idempotente. Guardas son requisitos, no código ejecutable. Estado de pedido es una proyección de máquinas independientes. Emitir evento después de persistir transición y outbox. Los estados no listados no se permiten por defecto. Cambios después de aprobación crean revisión nueva y pueden exigir compensaciones. Reembolsos parciales requieren ledger de importes; gestionar contracargos y reversión explícita.

## Design
```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> REVIEW: submit
    REVIEW --> APPROVED: approve
    REVIEW --> DRAFT: return
    APPROVED --> SUPERSEDED: replace
```


## Quote
```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> ISSUED: issue
    ISSUED --> ACCEPTED: accept
    ISSUED --> EXPIRED: expire
    ISSUED --> REJECTED: reject
    ISSUED --> SUPERSEDED: replace
```


## Payment
```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> PROCESSING: submit
    PENDING --> FAILED: fail
    PROCESSING --> CONFIRMED: confirm
    PROCESSING --> FAILED: fail
    CONFIRMED --> PARTIAL_REFUND: refund
    CONFIRMED --> REFUNDED: refund
    PARTIAL_REFUND --> REFUNDED: refund
    CONFIRMED --> DISPUTED: dispute
```


## Reservation
```mermaid
stateDiagram-v2
    [*] --> HELD
    HELD --> ALLOCATED: allocate
    HELD --> RELEASED: expire_or_cancel
    ALLOCATED --> CONSUMED: consume
    ALLOCATED --> RELEASED: release
```


## WorkOrder
```mermaid
stateDiagram-v2
    [*] --> PLANNED
    PLANNED --> RELEASED: release
    RELEASED --> IN_PROGRESS: start
    IN_PROGRESS --> BLOCKED: block
    BLOCKED --> IN_PROGRESS: resume
    IN_PROGRESS --> QA: submit
    QA --> IN_PROGRESS: rework
    QA --> DONE: approve
    PLANNED --> CANCELLED: cancel
```


## Shipment
```mermaid
stateDiagram-v2
    [*] --> PREPARED
    PREPARED --> DISPATCHED: ship
    DISPATCHED --> DELIVERED: deliver
    DISPATCHED --> INCIDENT: incident
    INCIDENT --> DELIVERED: resolve
    INCIDENT --> RETURNED: return
```


## Certificate
```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> ISSUED: issue
    ISSUED --> REVOKED: revoke
    ISSUED --> SUPERSEDED: replace
```


## Job
```mermaid
stateDiagram-v2
    [*] --> QUEUED
    QUEUED --> RUNNING: claim
    RUNNING --> SUCCEEDED: complete
    RUNNING --> FAILED: fail
    RUNNING --> QUEUED: retry
    QUEUED --> CANCELLED: cancel
    RUNNING --> CANCELLED: cancel
```


## Custody
```mermaid
stateDiagram-v2
    [*] --> REQUESTED
    REQUESTED --> IN_TRANSIT: handoff
    IN_TRANSIT --> RECEIVED: receive
    IN_TRANSIT --> DISCREPANCY: flag
    DISCREPANCY --> RECEIVED: resolve
```


## Service
```mermaid
stateDiagram-v2
    [*] --> REQUESTED
    REQUESTED --> RECEIVED: intake
    RECEIVED --> INSPECTED: inspect
    INSPECTED --> QUOTED: quote
    QUOTED --> AUTHORIZED: accept
    AUTHORIZED --> IN_PROGRESS: start
    IN_PROGRESS --> COMPLETED: complete
    COMPLETED --> RETURNED: return
```


## Order
```mermaid
stateDiagram-v2
    [*] --> PENDING_PAYMENT
    PENDING_PAYMENT --> CONFIRMED: confirm
    CONFIRMED --> FULFILLING: fulfill
    FULFILLING --> READY: ready
    READY --> DELIVERED: deliver
    PENDING_PAYMENT --> CANCELLED: cancel
    CONFIRMED --> CANCELLED: cancel
```


## Warranty
```mermaid
stateDiagram-v2
    [*] --> ACTIVE
    ACTIVE --> CLAIMED: claim
    CLAIMED --> IN_REVIEW: review
    IN_REVIEW --> RESOLVED: resolve
    ACTIVE --> EXPIRED: expire
```


## PurchaseOrder
```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> ISSUED: issue
    ISSUED --> PARTIAL: receive
    PARTIAL --> RECEIVED: receive
    ISSUED --> RECEIVED: receive
    ISSUED --> CANCELLED: cancel
```
