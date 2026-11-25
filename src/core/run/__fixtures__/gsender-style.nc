; Generated for GRBL – facing pass
; Units: inch!
G20 G90 ; inch, absolute
M3 S12000 ; spindle on
G0 X0 Y0 Z0.25
(Wait for spindle? -> pause)
M0 ; check the spindle speed
G1 Z-0.02 F20
G1 X2 F60
G1 Y1
G1 X0
G1 Y0
G0 Z0.25
M5
M2
