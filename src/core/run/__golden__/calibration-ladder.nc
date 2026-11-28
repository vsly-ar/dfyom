(Program: Plan 1)
(Setup: Calibration: feed ladder)
(Units: mm)
(Tool 1: 6 mm flat end mill, dia 6 mm)
(Generator: DFYOM test)
G90 G94 G17 G21
G54
G0 Z10
(Ladder step 1: F700)
(DFYOM TOOL CHANGE 1: 6 mm flat end mill, 6 mm flat)
M0 ;Install T1 6 mm flat end mill, 6 mm flat, then zero Z
G90 G94 G17 G21
G54
G0 Z10
M3 S18000
G4 P3
X50 Y20
Z2
G1 Z0 F300
X70 Z-0.75 F700
X50 Z-1.5
X70
G0 Z2
Z10
(Ladder step 2: F850)
X50 Y30
Z2
G1 Z0 F300
X70 Z-0.75 F850
X50 Z-1.5
X70
G0 Z2
Z10
(Ladder step 3: F1000)
X50 Y40
Z2
G1 Z0 F300
X70 Z-0.75 F1000
X50 Z-1.5
X70
G0 Z2
Z10
(Ladder step 4: F1150)
X50 Y50
Z2
G1 Z0 F300
X70 Z-0.75 F1000
X50 Z-1.5
X70 F1150
G0 Z2
Z10
(Ladder step 5: F1300)
X50 Y60
Z2
G1 Z0 F300
X70 Z-0.75 F1000
X50 Z-1.5
X70 F1300
G0 Z2
Z10
M5
M30
