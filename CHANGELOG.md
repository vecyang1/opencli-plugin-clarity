# Changelog - OpenCLI Plugin Clarity

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-04

### Added
- **Deterministic Project Discovery**: Fast project discovery loop with early break on `NOT_FOUND`.
- **Navigation Resilience (`safeGoto`)**: Automatic retry and recovery mechanism for unstable browser page transitions.
- **Comprehensive Test Suite**: Added unit and contract tests verifying root routing, navigation error states, and project id extraction.

### Fixed
- Fixed projects root navigation bug where URL paths failed to anchor properly on slow connections.

## [1.0.0] - 2026-08-25

### Added
- **Core OpenCLI Adapter**:
  - Direct integration with Microsoft Clarity via authenticated Chrome bridge.
  - Subcommands: `integrations`, `projects`, `audit`, and `traffic`.
  - Audits tracking integrations: Google Analytics (GA4), Google Tag Manager (GTM), Google Ads, and Microsoft Ads.
- **Data & Safety Contracts**:
  - Read-only contract ensuring zero unintended modifications to Clarity configurations.
  - 4-state status parsing: Connected, Not Connected, Pending, or Unknown.
  - Formatted JSON and ASCII table outputs.
