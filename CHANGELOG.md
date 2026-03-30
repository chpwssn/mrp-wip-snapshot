# Changelog

## 0.3.0

### Fixed

- Parts with open system-wide POs are no longer erroneously marked as BLIND. Lines initially classified as BLIND_SPOT are reclassified to ON_ORDER (system PO covers the gap) or PARTIAL (system PO exists but doesn't fully cover the gap). JO-level counts and the database are updated accordingly.
- On-hand inventory excludes non-netable locations (8 and 26). These locations no longer count toward STOCK_AVAILABLE classification or the On Hand column.
- I JOs now run through system PO enrichment, fixing BLIND_SPOT lines on I JOs that had system POs (e.g., I3322).

### Added

- I JOs with no issues now appear in the "No Action Needed" section alongside W JOs.
- Exhausted POs (fully received but short) are shown with strikethrough in the POs column to distinguish them from active POs.
- Non-standard part numbers (no INMASTX record) are flagged with an asterisk (`*`) in BOM tables.
- Page numbers ("Page X of Y") on printed pages.

### Changed

- "No Action Needed" section is now a compact comma-separated list instead of one bullet per JO.

## 0.2.0

- Initial tracked release. Status context in tables, forward support.
