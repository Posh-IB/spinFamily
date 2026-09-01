# SpinFamily

Copyright © 2026 Rootlayer. All rights reserved.

## Family Evening Planner

SpinFamily is a lightweight family evening-planning prototype designed to reduce the nightly “what should we do?” loop. The current public prototype uses a playful spin-wheel interaction, curated activity categories, random activity selection, and simple sequencing rules.

**Current Gate:** Gate 0–1 — Preserve Prototype + Product Truth  
**Managed deployment:** Netlify  
**Repository:** `Posh-IB/spinFamily`

> Product-truth note: the current prototype does **not** use machine learning, personalized recommendation models, weather data, cloud accounts, cross-device sync, or validated streak/variety analytics.

## Core Concept

SpinFamily helps households move from indecision to a usable evening plan through:

- a participatory spin interaction
- curated activity categories
- quick three-activity plans
- basic logical sequencing
- family participation
- session-only custom activities

Instead of asking *“What should we do tonight?”* — spin, review, and choose.

## Current Prototype Features

### Spin Wheel Planner

Each spin selects three distinct categories from:

- Chores
- Outdoor
- Family
- Self Care

One available activity is then randomly selected from each chosen category.

### Logical Plan Sequencing

Selected activities are ordered using simple deterministic constraints after random selection:

- chores/setup activities come earlier when present
- family/outdoor activities may vary in the middle
- self-care activities trend later
- **Early bedtime routine is always the final activity when selected**

This is a prototype sequencing layer, not Planner Engine v2.

### Family Member Context

Prototype household members include:

- Mom
- Dad
- Emma
- Lucas

Selecting a member currently changes planning context only. It does **not** personalize or score recommendations.

### Custom Activities

Users can add an activity name and category for the current browser session. Custom activities reset on refresh. Local persistence is scheduled for a later gate.

### Family-Friendly Text Screening

Custom activity names receive basic client-side screening for a small set of inappropriate terms. This is not represented as complete moderation or a guarantee of family safety.

### Explainable Prototype Output

The results screen states how the plan was produced: category selection, random activity selection, and sequencing rules. It does not display simulated ML, weather, or behavioral insights.

## Not Implemented Yet

The current prototype does not claim the following as live capabilities:

- machine-learning recommendations
- personalized member scoring
- account authentication
- cloud or cross-device synchronization
- weather-aware planning
- validated streak or variety analytics
- persistent completion history
- full Planner Engine v2 constraints/scoring

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML5 |
| Styling | CSS3 |
| Logic | Vanilla JavaScript |
| Managed hosting | Netlify |
| Source control | GitHub |

## Development State

The historical public prototype is preserved separately for evidence. Current vNext work follows the sequence:

**Preserve → Product Truth → UI → Planner → Persistence → Validation → ML Decision**

The differentiating Planner Engine v2 logic is intended to follow Rootlayer's private-core/public-demo boundary rather than expanding proprietary recommendation logic in the public prototype repository.

## Historical Files

Earlier prototype HTML variants remain in the repository as historical development artifacts. They are not the canonical current product surface. The canonical application entry point is `index.html`.

## License

See `LICENSE`.

## Author

Built by Posh-IB / Rootlayer.
