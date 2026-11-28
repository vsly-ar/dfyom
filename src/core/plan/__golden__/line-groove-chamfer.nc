(Program: Plan 1)
(Setup 1 of 1: Top)
(Stock X 100 Y 100 Z 10 mm on the machine)
(Faces: top up, front towards you, right on the right)
(Work zero G54 X0 Y0: front-left corner of the top face)
(That corner sits front left on the machine)
(Z0 on the top face: the stock surface facing up)
(Tool reaches past stock: left 8.4, right 8.4 mm)
(Keep clamps clear of those sides, below clearance Z 10 mm)
(Units: mm)
(Tool 1: Wexme 1/4in 1F, dia 6.22 mm, min stickout 8 mm)
(Tool 2: 90 V-bit 1/4in, dia 6.35 mm, min stickout 5.5 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Line 1)
(DFYOM TOOL CHANGE 1: Wexme 1/4in 1F, 6.22 mm flat, min stickout 8 mm)
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X2.836 Y50
Z2
G1 Z0 F150
X0 Z-0.5 F600
X100
X97.164
X100 Z-1
X0
X2.836
X0 Z-1.5
X100
X97.164
X100 Z-2
X0
X2.836
X0 Z-2.5
X100
X97.164
X100 Z-3
X0
G0 Z10
(Chamfer 1)
(Tool change to T2: spindle off, retract)
M5
X50
(Stop the spindle)
(DFYOM TOOL CHANGE 2: 90 V-bit 1/4in, 6.35 mm chamfer)
M0 ;Stop spindle, install T2 90 V-bit 1/4in, 6.35 mm, then zero Z
G90 G94 G17 G21
G54
G0 Z10
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X-5.175 Y53.11
Z2
G1 Z-0.5 F150
X0 F600
X100
X105.175
G0 Z10
M5
(Stop the spindle)
M0 ;Stop the spindle
M30
