(Program: Plan 1)
(Setup 1 of 1: Top)
(Stock X 80 Y 50 Z 12 mm on the machine)
(Faces: top up, front towards you, right on the right)
(Work zero G54 X0 Y0: front-left corner of the top face)
(That corner sits front left on the machine)
(Z0 on the top face: the stock surface facing up)
(Tool stays within the stock outline)
(Keep clamps below clearance Z 10 mm)
(Units: mm)
(Tool 1: V-bit 60, dia 6 mm, min stickout 9 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Line 1)
(DFYOM TOOL CHANGE 1: V-bit 60, 6 mm chamfer, min stickout 9 mm)
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X28.507 Y15
Z2
G1 Z-1.5 F1000
X20 Z-3 F2743.2
X60
X54.329
X60 Z-4
X20
G0 Z10
X40 Y30
Z2
G1 Z-1.5 F1000
X48.507 Z-3 F2743.2
X50
Y40
X30
Y30
X40
X48.507
X50 Z-3.263
Y34.178 Z-4
Y40
X30
Y30
X40
X50
Y34.178
G0 Z10
M5
(Stop the spindle)
M0 ;Stop the spindle
M30
