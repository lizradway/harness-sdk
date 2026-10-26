"""Embedders that turn text into vectors for vector search strategies.

Vended implementations live in their own modules, e.g. ``strands.storage.embeddings.bedrock``.
"""

from .embedder import Embedder

__all__ = [
    "Embedder",
]
