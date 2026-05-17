---
name: pantry
description: |
  Track the user's kitchen inventory across two states: SHOPPING (want to buy)
  and PANTRY (already have). Items flow shopping → pantry via mark_purchased.
  Use when the user mentions what they have / don't have, plans meals, or
  manages their grocery run. Composes with the gustus recipe app.
version: 0.2.0
when_to_use:
  - "the user says what they have or don't have ('I've got chicken and rice')"
  - "the user asks 'what can I make with what I have' (call list_pantry; cross with gustus)"
  - "the user is planning a recipe and needs to know what to buy (diff recipe ingredients against list_pantry; add missing to shopping)"
  - "the user just got back from the store ('I bought everything on my list' → call mark_purchased for each)"
  - "the user wants to see / edit their shopping list"
tools:
  - mcp_pantry_list_pantry
  - mcp_pantry_list_shopping
  - mcp_pantry_add_to_shopping
  - mcp_pantry_add_to_pantry
  - mcp_pantry_mark_purchased
  - mcp_pantry_remove_from_shopping
  - mcp_pantry_remove_from_pantry
---

# pantry

Tracks kitchen items in two states:

- **`shopping`** — the user wants to buy this, hasn't yet
- **`pantry`** — the user has it on hand

Lifecycle:
```
add_to_shopping ──► [shopping]  ──mark_purchased──►  [pantry] ──► remove_from_pantry
                       │                                ▲
                       │                                │
                       └── add_to_pantry (skip step) ───┘
```

## Cross-app composition with gustus

This is what makes pantry useful — it pairs with **gustus** (the recipe app)
for stateful meal-planning flows the user can iterate on:

1. *"What can I cook with what I have?"* → `list_pantry` + `mcp_gustus_list_recipes` + per-candidate `mcp_gustus_get_recipe` → pick best overlap.
2. *"Add the missing ingredients to my shopping list"* → for each missing ingredient, call `add_to_shopping`. Confirm the count.
3. *"I bought everything"* → call `list_shopping`, then `mark_purchased` for each. Or accept a partial list ("I got the eggs and milk but not the paprika").
4. *"Now what can I make?"* → re-run flow #1 with the updated pantry — answer changes because state changed.

## Conventions

- **Names: singular, lowercased.** The server normalizes (`Tomato` → `tomato`); you can pass any case but the agent should also normalize for clarity.
- **Adding overrides quantity.** "I bought 500g more chicken" is just `add_to_pantry({name: "chicken", quantity: 500, unit: "g"})` — replaces, doesn't sum.
- **Be specific.** Don't add "vegetables" or "spices" — ask what specifically.
- **Confirm bulk operations.** Before adding 8 things to the shopping list, summarize them and ask "add all of these?"
- **Confirm removes.** Removal is permanent; if the user said "I used some flour" they probably meant a quantity update via `add_to_pantry`, not `remove_from_pantry`.

## Failure modes

- `no item named X on either list` (from `mark_purchased`) — the agent or user is referencing something that was never added. Offer to `add_to_pantry` directly if they bought something not previously on the list.
- `X is already in the pantry` (from `mark_purchased`) — no-op; tell the user.

## Tone in responses

After multi-step operations, summarize in one line:
- "Added eggs, paprika, and bread to your shopping list (3 items)."
- "Marked all 5 items as purchased — they're in your pantry now."
- Don't enumerate every server response back to the user — collapse them.
