"""Adapter selection. Fails closed: no real provider is implemented or enabled.

- `simulated` is refused in production, so demo data never reaches it.
- Any real provider (Meshy, Tripo, ...) raises PROVIDER_NOT_CONFIGURED until an
  adapter exists, its commercial terms are verified and ian authorizes it.
"""
from __future__ import annotations

from .adapter import MeshAdapter, ProviderNotConfigured
from .simulated import SimulatedMeshAdapter

ENVIRONMENTS = ("demo", "test", "production")


def build_adapter(provider: str, environment: str) -> MeshAdapter:
    if environment not in ENVIRONMENTS:
        raise ProviderNotConfigured(f"unknown environment {environment!r}")
    if provider == "simulated":
        if environment == "production":
            raise ProviderNotConfigured("simulated mesh provider is not allowed in production")
        return SimulatedMeshAdapter()
    raise ProviderNotConfigured(
        f"mesh provider {provider!r} is not implemented or not authorized; "
        "real providers require verified terms and explicit authorization"
    )
