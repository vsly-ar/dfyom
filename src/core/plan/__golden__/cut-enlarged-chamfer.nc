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
(Tool 1: Chamfer 6 tip 0, dia 6 mm, min stickout 6.5 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Chamfer 1)
(DFYOM TOOL CHANGE 1: Chamfer 6 tip 0, 6 mm chamfer)
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X40 Y20
Z2
G1 Z-0.5 F1000
G3 Y30 Z-1 I0 J5 F2592
Y20 Z-1.5 I0 J-5
Y30 I0 J5
Y20 I0 J-5
Y25 I0 J2.5
G0 Z10
M5
(Stop the spindle)
M0 ;Stop the spindle
M30
