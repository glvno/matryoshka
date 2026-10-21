# Domain documentation

Read README.md, docs/ARCHITECTURE.md and LICENSING.md. Tutorial behavior is specified in docs/TUTORIAL.md. User-visible complete sounds are patches; reusable nested building blocks are assemblies. Firmware is outside this tutorial work.
- **Engine** (#159): an assembly with a `keys` input and an `audio` output (`web/src/engines.ts`); pitch + gate assemblies are voices. Glossary in docs/ARCHITECTURE.md "Engines, voices, drums".
