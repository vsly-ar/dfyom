(Program: Plan 1)
(Setup 1 of 1: Top)
(Stock X 100 Y 100 Z 10 mm on the machine)
(Faces: top up, front towards you, right on the right)
(Work zero G54 X0 Y0: front-left corner of the top face)
(That corner sits front left on the machine)
(Z0 on the top face: the stock surface facing up)
(Tool reaches past stock: left 8.3, right 8.3 mm)
(Keep clamps clear of those sides, below clearance Z 10 mm)
(Units: mm)
(Tool 1: Wexme 1/4in 1F, dia 6.22 mm, min stickout 15.4 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Line 1)
(DFYOM TOOL CHANGE 1: Wexme 1/4in 1F, 6.22 mm flat)
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X-5.11 Y22
Z2
G1 Z-0.495 F150
X0 F600
X100
X105.11
Z-0.99 F150
X100 F600
X0
X-5.11
Z-1.486 F150
X0 F600
X100
X105.11
Z-1.981 F150
X100 F600
X0
X-5.11
Z-2.476 F150
X0 F600
X100
X105.11
Z-2.971 F150
X100 F600
X0
X-5.11
Z-3.467 F150
X0 F600
X100
X105.11
Z-3.962 F150
X100 F600
X0
X-5.11
Z-4.457 F150
X0 F600
X100
X105.11
Z-4.952 F150
X100 F600
X0
X-5.11
Z-5.448 F150
X0 F600
X100
X105.11
Z-5.943 F150
X100 F600
X0
X-5.11
Z-6.438 F150
X0 F600
X100
X105.11
Z-6.933 F150
X100 F600
X0
X-5.11
Z-7.429 F150
X0 F600
X100
X105.11
Z-7.924 F150
X100 F600
X0
X-5.11
Z-8.419 F150
X0 F600
X100
X105.11
Z-8.914 F150
X100 F600
X0
X-5.11
Z-9.41 F150
X0 F600
X100
X105.11
Z-9.905 F150
X100 F600
X0
X-5.11
Z-10.4 F150
X0 F600
X100
X105.11
G0 Z10
M5
(Stop the spindle)
M0 ;Stop the spindle
M30
