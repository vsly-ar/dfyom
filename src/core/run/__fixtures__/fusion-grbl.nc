%
(1001)
(Machine)
(  vendor: Generic)
(  model: GRBL router)
(T1  D=6 CR=0 - ZMIN=-3 - flat end mill)
(T2  D=3.175 CR=0 - ZMIN=-2 - flat end mill)
G90 G94
G17
G21

(Pocket1)
T1 M6
S18000 M3
G54
M8
G0 X10 Y10
Z15
Z5
G1 Z1 F1000
Z-3 F300
X40 F1200
Y30
G2 X30 Y40 I-10 J0
G1 X10
Y10
G0 Z15

(Contour2)
M9
M5
T2 M6
(2D Contour 3 mm)
S20000 M3
G0 X5 Y5
G1 Z-2 F250
G3 X5 Y5 I10 J0 F900
G0 Z15
M5
G49 G40 G80
M30
%
