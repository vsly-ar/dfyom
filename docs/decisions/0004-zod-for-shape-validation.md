# 0004 – Zod for shape validation of untrusted data

Status: accepted · Date: 2026-11-16

## Context

Data enters the app from files, IPC, agent tool calls and external devices. Casting it (`raw as Dto`) would let malformed data reach models and fail in confusing ways. Model invariants ([ADR 0002](0002-oxide-ts-result-option.md)) check domain rules but assume correctly typed input. The LLM-first agent API ([principles.md §1](../principles.md#1-llm-first)) also needs JSON Schemas describing every command's arguments.

## Decision

Use **Zod 4** to check the **shape** of all untrusted data, through one helper that converts Zod failures into `AppError` (`input.malformed`). Zod schemas are the contract for current DTO shapes (`z.infer`), and generate the agent API's JSON Schemas (`z.toJSONSchema`).

## Consequences

- Two layers with a clear split: schemas check structure and types; models check domain invariants. Rules are not duplicated between them.
- One definition per DTO serves validation, TypeScript types and agent tool schemas.
- Usage: [conventions/error-handling/helpers.md](../conventions/error-handling/helpers.md#parsing-untrusted-data-zod).
