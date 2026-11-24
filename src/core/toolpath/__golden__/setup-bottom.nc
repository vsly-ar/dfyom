(Program: Plan 1)
(Setup 1 of 1: Bottom)
(Stock X 100 Y 60 Z 20 mm on the machine)
(Faces: bottom up, back towards you, right on the right)
(Work zero G54 X0 Y0: back-left corner of the bottom face)
(That corner sits front left on the machine)
(Z0 on the bottom face: the stock surface facing up)
(Tool reaches past stock: left 7, right 7, front 1, back 1 mm)
(Keep clamps clear of those sides, below clearance Z 10 mm)
(Units: mm)
(Tool 1: Flat 6, dia 6 mm)
(Generator: DFYOM)
G90 G94 G17 G21
G54
G0 Z10
(Facing 1)
(DFYOM TOOL CHANGE 1: Flat 6, 6 mm flat)
M3 S18000
(Set spindle to 18000 rpm)
M0 ;Set spindle to 18000 rpm
X104 Y2
Z2
G1 Z-0.5 F200
X-4 F800
Y4.947
X104
Y7.895
X-4
Y10.842
X104
Y13.789
X-4
Y16.737
X104
Y19.684
X-4
Y22.632
X104
Y25.579
X-4
Y28.526
X104
Y31.474
X-4
Y34.421
X104
Y37.368
X-4
Y40.316
X104
Y43.263
X-4
Y46.211
X104
Y49.158
X-4
Y52.105
X104
Y55.053
X-4
Y58
X104
G0 Z2
Z10
(Pocket 1)
X43.2 Y30
Z1.5
G1 Z-0.5 F200
X56.8 Z-1 F800
X43.2 Z-1.5
X56.8
X50
Y28.5
X56.5
Y31.5
X43.5
Y28.5
X50
Y28.2
X56.8
Y31.8
X43.2
Y28.2
X50
G0 Z1.5
X43.2 Y30
G1 Z-1.5 F200
X56.8 Z-2 F800
X43.2 Z-2.5
X56.8
X50
Y28.5
X56.5
Y31.5
X43.5
Y28.5
X50
Y28.2
X56.8
Y31.8
X43.2
Y28.2
X50
G0 Z1.5
X43.2 Y30
G1 Z-2.5 F200
X56.8 Z-3 F800
X43.2 Z-3.5
X56.8
X50
Y28.5
X56.5
Y31.5
X43.5
Y28.5
X50
Y28.2
X56.8
Y31.8
X43.2
Y28.2
X50
G0 Z1.5
G1 Z-3.5 F200
Y28 F2228.3
X57
Y32
X43
Y28
X50
Y28.2
G0 Z1.5
Z10
M5
(Stop the spindle)
M0 ;Stop the spindle
M30
