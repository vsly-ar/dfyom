(Program: Plan 1)
(Setup: Right)
(Units: mm)
(Tool 1: Drill 6, dia 6 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Drilling 1, Drilling 2)
(DFYOM TOOL CHANGE 1: Drill 6)
M3 S3000
(Set spindle to 3000 rpm)
M0
X72.5 Y20
Z2
G1 Z-4 F300
G0 Z2
Z-3.5
G1 Z-8
G0 Z2
Z-7.5
G1 Z-12
G0 Z2
Z-11.5
G1 Z-15.803
G0 Z2
Z10
X112.5
Z2
G1 Z-4
G0 Z2
Z-3.5
G1 Z-8
G0 Z2
Z-7.5
G1 Z-12
G0 Z2
Z-11.5
G1 Z-15.803
G0 Z2
Z10
M5
(Stop the spindle)
M0
M30
