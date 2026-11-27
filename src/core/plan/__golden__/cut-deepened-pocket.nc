(Program: Plan 1)
(Setup 1 of 1: Top)
(Stock X 80 Y 50 Z 12 mm on the machine)
(Faces: top up, front towards you, right on the right)
(Work zero G54 X0 Y0: front-left corner of the top face)
(That corner sits front left on the machine)
(Z0 for tool 1 on Facing 1 floor: see the first tool change)
(Tool stays within the stock outline)
(Keep clamps below clearance Z 10 mm)
(Units: mm)
(Tool 1: Flat 6, dia 6 mm, Z0 on Facing 1 floor, min stickout 13.5 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10.5
(Pocket 1)
X10 Y25
(Z0 for tool 1: Facing 1 floor, 0.50 below the stock top)
(Touch off Z here, X10 Y25: set Z0 on that surface)
(DFYOM TOOL CHANGE 1: Flat 6, 6 mm flat, min stickout 13.5 mm)
M0 ;Install T1 Flat 6, 6 mm flat, then zero Z on Facing 1 floor
G90 G94 G17 G21
G54
G0 Z10.5
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X40 Y22.6
Z2
G1 Z-6 F1000
G3 Y27.4 Z-6.25 I0 J2.4 F2743.2
Y22.6 Z-6.5 I0 J-2.4
Y27.4 Z-6.75 I0 J2.4
Y22.6 Z-7 I0 J-2.4
Y27.4 I0 J2.4
Y22.6 I0 J-2.4
G1 Y23.8
X46.2
Y26.2
X33.8
Y23.8
X40
Y21.74
X48.26
Y28.26
X31.74
Y21.74
X40
Y19.68
X50.32
Y30.32
X29.68
Y19.68
X40
Y17.62
X52.38
Y32.38
X27.62
Y17.62
X40
Y15.56
X54.44
Y34.44
X25.56
Y15.56
X40
Y13.5
X56.5
Y36.5
X23.5
Y13.5
X40
G0 Z2
Y22.6
G1 Z-7 F1000
G3 Y27.4 Z-7.25 I0 J2.4 F2743.2
Y22.6 Z-7.5 I0 J-2.4
Y27.4 Z-7.75 I0 J2.4
Y22.6 Z-8 I0 J-2.4
Y27.4 I0 J2.4
Y22.6 I0 J-2.4
G1 Y23.8
X46.2
Y26.2
X33.8
Y23.8
X40
Y21.74
X48.26
Y28.26
X31.74
Y21.74
X40
Y19.68
X50.32
Y30.32
X29.68
Y19.68
X40
Y17.62
X52.38
Y32.38
X27.62
Y17.62
X40
Y15.56
X54.44
Y34.44
X25.56
Y15.56
X40
Y13.5
X56.5
Y36.5
X23.5
Y13.5
X40
G0 Z2
G1 Z-8 F1000
Y13 F4962.6
X57
Y37
X23
Y13
X40
Y13.5
G0 Z2
Z10.5
M5
(Stop the spindle)
M0 ;Stop the spindle
M30
