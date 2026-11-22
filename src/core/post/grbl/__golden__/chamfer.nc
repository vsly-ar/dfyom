(Program: Plan 1)
(Setup: Setup 1)
(Units: mm)
(Tool 1: 6 mm chamfer mill, dia 6 mm)
(Tool 2: 12 mm chamfer mill, dia 12 mm)
(Generator: DFYOM test)
G90 G94 G17 G21
G54
G0 Z10
(op-chamfer1)
(DFYOM TOOL CHANGE 1: 6 mm chamfer mill)
M3 S16000
G4 P3
X10 Y12
Z2
G1 Z0 F200
G3 Y18 Z-0.25 I0 J3 F800
Y12 Z-0.5 I0 J-3
Y18 I0 J3
Y12 I0 J-3
Y15 I0 J1.5
G0 Z10
(op-chamfer2)
M5
(DFYOM TOOL CHANGE 2: 12 mm chamfer mill)
M0
G90 G94 G17 G21
G54
G0 Z10
M3 S16000
G4 P3
X30 Y15
Z2
G1 Z-3.5 F200
G0 Z10
M5
M30
