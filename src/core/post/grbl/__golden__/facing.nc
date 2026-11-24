(Program: Plan 1)
(Setup: Setup 1)
(Units: mm)
(Tool 1: 10 mm flat end mill, dia 10 mm)
(Generator: DFYOM test)
G90 G94 G17 G21
G54
G0 Z10
(op-facing)
(DFYOM TOOL CHANGE 1: 10 mm flat end mill, 10 mm flat)
M3 S18000
G4 P3
X36 Y4
Z2
G1 Z-0.5 F300
X-6 F1200
Y10
X36
Y16
X-6
G0 Z2
Z10
M5
M30
