# GuideHerd Diagrams

Architecture and flow diagrams live here.

None are checked in yet. When added, keep them consistent with the layering in
[ARCHITECTURE.md](../../ARCHITECTURE.md):

```
Customer → GuideHerd Experience → GuideHerd Business Services → Vendor Implementations
```

Diagrams should show GuideHerd services and the customer flow
(Receptionist → GuideHerd → Lex). Vendors, when shown at all, belong at the
bottom layer and should be labeled as replaceable implementations.

Prefer text-based, diffable formats (e.g. Mermaid or SVG) over binary exports.
