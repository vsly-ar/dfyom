(Program: Plan 1)
(Setup: Setup 1)
(Units: mm)
(Tool 1: 6 mm drill, dia 6 mm)
(Generator: DFYOM test)
G90 G94 G17 G21
G54
G0 Z10
(op-drill1)
(DFYOM TOOL CHANGE 1: 6 mm drill, 6 mm drill)
M3 S3000
G4 P3
X10 Y15
Z2
G1 Z-5 F150
G0 Z2
Z-4.5
G1 Z-10
G0 Z2
Z-9.5
G1 Z-13.803
G0 Z2
Z10
(op-drill2)
X30
Z2
G1 Z-4
G0 Z-3.5
G1 Z-8
G0 Z-7.5
G1 Z-12
G0 Z-11.5
G1 Z-13.803
G0 Z2
Z10
M5
M30
