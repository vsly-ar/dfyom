(Program: Plan 1)
(Setup 1 of 2: Bottom)
(Stock X 255 Y 185 Z 40 mm on the machine)
(Faces: bottom up, back towards you, right on the right)
(Work zero G54 X0 Y0: back-left corner of the bottom face)
(That corner sits front left on the machine)
(Z0 on the bottom face: the stock surface facing up)
(Tool stays within the stock outline)
(Keep clamps below clearance Z 10 mm)
(Units: mm)
(Tool 1: Drill 3, dia 3 mm)
(Tool 2: Flat 6, dia 6 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Drilling 1, Drilling 2, Drilling 3, Drilling 4)
(DFYOM TOOL CHANGE 1: Drill 3)
M3 S5000
(Set spindle to 5000 rpm)
M0
X39 Y48.2
Z2
G1 Z-4.801 F250
G0 Z2
Z10
Y136.8
Z2
G1 Z-4.801
G0 Z2
Z10
X216
Z2
G1 Z-4.801
G0 Z2
Z10
Y48.2
Z2
G1 Z-4.801
G0 Z2
Z10
(Profile 2)
M5
(Stop the spindle)
(DFYOM TOOL CHANGE 2: Flat 6)
M0
G90 G94 G17 G21
G54
G0 Z10
M3 S16000
(Set spindle to 16000 rpm)
M0
X97.5 Y82.5
Z2
G1 Z0 F600
X116.581 Z-1 F3000
X97.5
X137.5
G3 X157.5 Y102.5 I0 J20
G0 Z2
Z10
M5
(Stop the spindle)
M0
M30
