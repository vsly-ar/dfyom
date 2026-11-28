(Program: Plan 1)
(Setup: Setup 1)
(Units: mm)
(Tool 1: 3.175 mm tapered ball end mill, dia 3.175 mm)
(Generator: DFYOM test)
G90 G94 G17 G21
G54
G0 Z10
(op-line1)
(DFYOM TOOL CHANGE 1: 3.175 mm, 3.175 mm tapered ball R0.25 3.6 deg)
M3 S18000
G4 P3
X10 Y15
Z2
G1 Z-0.3 F300
X13.968 Z-0.4 F600
X30
G3 X40 Y25 I0 J10
G1 Z-0.8 F300
G2 X30 Y15 I-10 J0 F600
G1 X29.838
X10 Z-0.3
X30 Z-0.804
G3 X40 Y25 Z-1.2 I0 J10
G0 Z10
M5
M30
