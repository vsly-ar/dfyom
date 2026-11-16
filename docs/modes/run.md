# Run mode

Status: draft · Terms: [glossary.md](../glossary.md)

**Goal:** interact with the CNC machine. The baseline is running gCode; the mode goes far beyond that by integrating external devices.

## Devices

- **Sensors:** cameras, vibration, temperature, weight/pressure, distance, power consumption, flow meters, encoders, external RPM monitor (when the spindle doesn't report RPM).
- **Actuators:** servos, solenoids, relays, alarms, …
- Usually reached through **external controllers (MCUs)** the app communicates with.

## What this enables

1. **Detection of things going wrong** – chatter, loose parts, air-cutting where the tool should be engaging, collisions; machine vision for humans and other foreign objects.
2. **Extended machine capabilities** – external tool-changer automation; coolant / mist / compressed air / vacuum cleaning / vacuum table / ventilation / temperature automations.
3. **Lights-out cycles** – automatic setup changes, collecting finished parts, replacing stock and restarting the cycle.
4. **Calibration, measurement, testing, troubleshooting** – (semi-)automatic: resonant frequencies, motor load, thermal behaviour, tolerances/precision.

## Automation and LLMs

Automations can be scripts (JS/TS/Python/Lua) authored by users or LLMs, and/or an active LLM session watching the run via hooks and periodic checks. → [architecture/llm-api.md](../architecture/llm-api.md)

## Safety

To be specified before any real-machine control is implemented: e-stop semantics, what automation/LLMs may never do without confirmation, watchdogs.

## Open questions

- Machine controller protocols to support first (GRBL, grblHAL, FluidNC, LinuxCNC, …).
- MCU communication protocol (serial, USB, network; message schema).
- Script sandboxing per language.
