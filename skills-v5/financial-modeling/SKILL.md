---
name: financial-modeling
description: Build and audit financial forecasts, linked statements, cash flows, and valuation models with traceable assumptions. Use when a financial model, debt or capital schedule, scenario analysis, or model audit is requested; not for investment recommendations or funding decisions without modeling.
---

# Financial Modeling

Own the quantitative model and audit trail, not the business approval decision. A model should make source data, assumptions, formulas, timing, dependencies, and error checks explicit enough that another analyst can trace every headline output to its drivers.

## Establish the model contract

State the model purpose, decision horizon, reporting periods, currency and units, nominal/real basis, accounting/operating conventions, source hierarchy, scenario set, and required outputs. Resolve historical period definitions before importing data; fiscal-year and calendar-quarter labels are not interchangeable.

Separate source/historical data, assumptions, calculations, schedules, outputs, and checks. Do not hard-code a forecast result into formulas that should be driven by assumptions. Keep units and signs consistent and document any intentionally unusual convention.

## Historical and driver foundation

Reconcile historical inputs to authoritative source records before forecasting. For public companies, use the actual filing/XBRL fact and period context rather than treating an aggregated frame as a substitute for the filed statement when the distinction matters.

Define operating drivers at the causal grain available: price × volume, customers × ARPU, headcount × compensation, units × unit cost, utilization × capacity, or another explicit driver structure. Forecast assumptions should be visible and traceable; a smooth growth percentage is not automatically a driver model.

## Linked model mechanics

For a three-statement model, link income statement, balance sheet and cash flow consistently. Model working capital, capex/depreciation, taxes, debt/interest, equity/financing and retained earnings as appropriate to scope. The balance sheet must balance for economic reasons, not because an unexplained plug absorbs every error.

For DCF or project cash-flow models, define free-cash-flow construction, investment timing, taxes, working capital, terminal or residual assumptions, discounting dates/convention, and nominal/real consistency. For debt models, state opening balances, draws, repayments, rates, fees, covenants and cash sweeps where relevant.

Make circularity explicit. Use a documented iterative/circular approach, controlled approximation, or clearly justified simplifying assumption; do not disguise a broken link with a plug.

## Scenarios and sensitivity

Keep scenario assumptions internally coherent. Base/downside/upside are conditional cases, not probability forecasts unless probabilities are separately justified. Stress the few drivers that dominate the output and use sensitivity analysis to show which assumptions matter most. When drivers are correlated, use coherent scenarios or joint uncertainty rather than impossible independent combinations.

## Model audit

Reconcile historical statements/facts to source records. Run balance-sheet, cash-flow, debt-rollforward, retained-earnings, working-capital, units/sign, date, scenario-switch and formula-consistency checks appropriate to the model. Inspect copied formulas for drift, hard-coded constants inside formula regions, broken references, hidden balancing items, and inconsistent period transitions.

Trace every headline output to source data and assumption cells. Label missing or simulated source data rather than silently fabricating it. Preserve model limitations and output uncertainty.

## Boundaries

- `business-case-analysis` owns alternatives, strategic fit, opportunity cost, risk and the investment/approval recommendation. This skill provides the quantitative model used inside that case.
- `data-analysis` owns general descriptive/statistical analysis not requiring a linked financial model.
- `procurement-vendor-evaluation` owns supplier scoring and due diligence.
- `contract-analysis` owns legal/commercial term review; financial-modeling may translate verified terms into model inputs when requested.

Compose when the user needs both outputs, but keep model integrity separate from the downstream decision.

## Failure boundaries

Do not hard-code outputs into formulas, mix nominal and real values or monthly and annual units, use stale/wrong-period source facts, hide circularity or balancing plugs, double-count cash flows between statements/schedules, assume scenario outputs are predictions, or present unsupported precision where the model inputs are ranges or weak evidence.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts. Keep this skill inside its declared responsibility; adjacent skills may compose with it but do not erase its evidence boundary.
