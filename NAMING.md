# Naming — Cirrus Portal

**Decision (2026-09-10):** the portal's official name is **Cirrus Portal**.

## Why

- **It fits the family line.** The control plane was already claimed as
  **Cirrus Core** — "the portal *is* the control plane; the portal is just today's
  implementation" (Elara, Aug 2026). Naming the web surface **Cirrus Portal**
  makes the product family coherent: *Cirrus Core* is the engine, *Cirrus Portal*
  is the console people actually touch.
- **It says what it is.** "Portal" is honest — a browser console into your agent
  fleet. "Cirrus" carries the fleet/cloud/system meaning without sounding generic.
- **It's deployment-ready.** Short, spellable, one word of jargon, works as a
  package name (`cirrus-portal`), a container name, and a domain stem.

## Family map

| Layer | Name | What it is |
| --- | --- | --- |
| Engine / control plane | **Cirrus Core** | Registry, config, identity, licensing, dashboards, plugin mgmt |
| Web console | **Cirrus Portal** | The browser UI: chat, agents, rooms, roles, admin |
| Lab surface | **Nexus** | Spark-lab control dashboard (served by Cirrus Core) |

## Alternates (rejected)

- **Aegis Portal** — collides with the family chat ("Pocket AEGIS"); too guarded-sounding.
- **Nexus** — already taken by the lab dashboard surface; keeping both would confuse.
- **Wraith** — that's the palette name, not a product; too aggressive for a public tool.

## Single source of truth

`branding.json` in this directory holds the canonical strings. Code, installer,
and docs read from it (or mirror it) — **rename here first, then propagate**.

```json
{ "product": "Cirrus Portal", "shortName": "Cirrus", "family": "Cirrus",
  "engine": "Cirrus Core", "slug": "cirrus-portal",
  "tagline": "Mission control for your OpenClaw fleet." }
```

## Voice / copy rules

- Full name in titles and headers: **Cirrus Portal**.
- Sidebar wordmark splits as **Cirrus** + accent **Portal**.
- CLI/installer banner: `Cirrus Portal`.
- Never "Agent Portal" in new copy. Legacy strings in old release notes are fine.
