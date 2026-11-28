(Program: Plan 1)
(Setup 1 of 1: Top)
(Stock X 100 Y 100 Z 10 mm on the machine)
(Faces: top up, front towards you, right on the right)
(Work zero G54 X0 Y0: front-left corner of the top face)
(That corner sits front left on the machine)
(Z0 on the top face: the stock surface facing up)
(Tool stays within the stock outline)
(Keep clamps below clearance Z 10 mm)
(Units: mm)
(Tool 1: Wexme 1/4in 1F, dia 6.22 mm, min stickout 8 mm)
(Tool 2: 90 V-bit 1/4in, dia 6.35 mm, min stickout 5.5 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Profile 1)
(DFYOM TOOL CHANGE 1: Wexme 1/4in 1F, 6.22 mm flat, min stickout 8 mm)
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X30 Y35
Z2
G1 Z0 F150
Y44.541 Z-0.5 F600
Y65
X70
Y35
X30
Y44.541
G0 Z2
Y35
G1 Z-0.5 F150
Y44.541 Z-1 F600
Y65
X70
Y35
X30
Y44.541
G0 Z2
Y35
G1 Z-1 F150
Y44.541 Z-1.5 F600
Y65
X70
Y35
X30
Y44.541
G0 Z2
Y35
G1 Z-1.5 F150
Y44.541 Z-2 F600
Y65
X70
Y35
X30
Y44.541
G0 Z2
Y35
G1 Z-2 F150
Y44.541 Z-2.5 F600
Y65
X70
Y35
X30
Y44.541
G0 Z2
Y35
G1 Z-2.5 F150
Y44.541 Z-3 F600
Y65
X70
Y35
X30
Y44.541
G0 Z2
Z10
(Chamfer 1)
(Tool change to T2: spindle off, retract)
M5
X18 Y18
(Stop the spindle)
(DFYOM TOOL CHANGE 2: 90 V-bit 1/4in, 6.35 mm chamfer)
M0 ;Stop spindle, install T2 90 V-bit 1/4in, 6.35 mm, then zero Z
G90 G94 G17 G21
G54
G0 Z10
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X39.541 Y31.89
Z2
G1 Z0 F150
X30 Z-0.5 F600
X70
G3 X73.11 Y35 I0 J3.11
G1 Y65
G3 X70 Y68.11 I-3.11 J0
G1 X30
G3 X26.89 Y65 I0 J-3.11
G1 Y35
G3 X30 Y31.89 I3.11 J0
G0 Z10
M5
(Stop the spindle)
M0 ;Stop the spindle
M30
