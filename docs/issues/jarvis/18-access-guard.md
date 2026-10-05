# 18 · Access guard before shipping

Type: HITL

## Parent

[docs/JARVIS.md](../../JARVIS.md)

## What to build

gitbot has no authentication and can be reached from the network. With Jarvis holding `gh` and starting children in auto-approve, the open port is the whole machine and the user's GitHub account. Decide, then build, one of:

- an access token required on API and UI requests (shown in the terminal / QR code at start), or
- Jarvis restricted to requests from localhost until a token exists.

Must not break the existing phone-on-LAN flow for non-Jarvis use without a deliberate decision.

## Acceptance criteria

- [ ] Decision recorded in `docs/JARVIS.md`
- [ ] Chosen guard implemented and enforced on every Jarvis route and tool path
- [ ] Unauthorised request is refused with a clear error
- [ ] Tests: guard allows and refuses as specified

## Blocked by

None - can start immediately; required before Jarvis ships
