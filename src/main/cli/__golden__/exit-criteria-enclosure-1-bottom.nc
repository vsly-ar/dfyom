(Program: Plan 1)
(Setup 1 of 3: Bottom)
(Stock X 255 Y 185 Z 40 mm on the machine)
(Faces: bottom up, back towards you, right on the right)
(Work zero G54 X0 Y0: back-left corner of the bottom face)
(That corner sits front left on the machine)
(Z0 on the bottom face: the stock surface facing up)
(Tool stays within the stock outline)
(Keep clamps below clearance Z 10 mm)
(Units: mm)
(Tool 1: Flat 6, dia 6 mm, min stickout 7 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Pocket 2)
(DFYOM TOOL CHANGE 1: Flat 6, 6 mm flat, min stickout 7 mm)
M3 S16000
(Set spindle to 16000 rpm)
M0 ;Set spindle to 16000 rpm
X127.5 Y90.1
Z2
G1 Z0 F600
G3 Y94.9 Z-0.333 I0 J2.4 F3000
Y90.1 Z-0.667 I0 J-2.4
Y94.9 Z-1 I0 J2.4
Y90.1 Z-1.333 I0 J-2.4
Y94.9 Z-1.667 I0 J2.4
Y90.1 Z-2 I0 J-2.4
Y94.9 I0 J2.4
Y90.1 I0 J-2.4
G1 Y91
X149
Y94
X106
Y91
X127.5
Y88
X152
Y97
X103
Y88
X127.5
Y85
X155
Y100
X100
Y85
X127.5
Y82
X158
Y103
X97
Y82
X127.5
Y79
X161
Y106
X94
Y79
X127.5
Y76
X163.5
G3 X164 Y76.5 I0 J0.5
G1 Y108.5
G3 X163.5 Y109 I-0.5 J0
G1 X91.5
G3 X91 Y108.5 I0 J-0.5
G1 Y76.5
G3 X91.5 Y76 I0.5 J0
G1 X127.5
G0 Z2
G1 Z-2 F600
Y75.5 F5000
X163.5
G3 X164.5 Y76.5 I0 J1
G1 Y108.5
G3 X163.5 Y109.5 I-1 J0
G1 X91.5
G3 X90.5 Y108.5 I0 J-1
G1 Y76.5
G3 X91.5 Y75.5 I1 J0
G1 X127.5
Y76
G0 Z2
Z10
M5
(Stop the spindle)
M0 ;Stop the spindle
M30
