(Program: Plan 1)
(Setup 2 of 3: Right)
(Stock X 185 Y 40 Z 255 mm on the machine)
(Faces: right up, bottom towards you, back on the right)
(From setup 1: tip its right side up, then turn 90 deg CCW)
(Work zero G54 X0 Y0: bottom-front corner of the right face)
(That corner sits front left on the machine)
(Z0 on the right face: the stock surface facing up)
(Tool stays within the stock outline)
(Keep clamps below clearance Z 10 mm)
(Units: mm)
(Tool 1: Drill 6, dia 6 mm, min stickout 19 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Drilling 1, Drilling 2)
(DFYOM TOOL CHANGE 1: Drill 6, 6 mm drill, min stickout 19 mm)
M3 S3000
(Set spindle to 3000 rpm)
M0 ;Set spindle to 3000 rpm
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
M0 ;Stop the spindle
M30
