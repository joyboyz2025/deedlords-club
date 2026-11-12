# Inspector Grigg: a stocky guard in plate, a halberd standing on the ground in his right hand, a round shield on his
# left arm that faces out to his side.
BONES = [
    ("hips", (0, 0.06, 0.42), (0, 0.06, 0.50), None),
    ("spine", (0, 0.06, 0.50), (0, 0.06, 0.60), "hips"),
    ("chest", (0, 0.06, 0.60), (0, 0.06, 0.72), "spine"),
    ("head", (0, 0.04, 0.74), (0, 0.04, 0.88), "chest"),
    ("upper_arm.R", (-0.17, 0.03, 0.72), (-0.2, 0.02, 0.56), "chest"),
    ("forearm.R", (-0.2, 0.02, 0.56), (-0.24, -0.135, 0.55), "upper_arm.R"),
    # The halberd: its blade and upper shaft turn with the hand, the lower shaft follows.
    ("hand.R", (-0.24, -0.135, 0.55), (-0.24, -0.13, 0.98), "forearm.R"),
    ("shaft.R", (-0.24, -0.135, 0.55), (-0.24, -0.125, 0.02), "hand.R"),
    ("upper_arm.L", (0.17, 0.03, 0.72), (0.21, 0.03, 0.56), "chest"),
    ("forearm.L", (0.21, 0.03, 0.56), (0.24, 0.0, 0.45), "upper_arm.L"),
    ("shield.L", (0.27, 0.0, 0.58), (0.27, 0.0, 0.30), "forearm.L"),
    ("thigh.L", (0.08, 0.05, 0.42), (0.135, 0.03, 0.23), "hips"),
    ("shin.L", (0.135, 0.03, 0.23), (0.16, 0.06, 0.07), "thigh.L"),
    ("foot.L", (0.16, 0.06, 0.07), (0.18, -0.04, 0.02), "shin.L"),
    ("thigh.R", (-0.08, 0.05, 0.42), (-0.15, 0.03, 0.23), "hips"),
    ("shin.R", (-0.15, 0.03, 0.23), (-0.15, 0.06, 0.07), "thigh.R"),
    ("foot.R", (-0.15, 0.06, 0.07), (-0.17, -0.04, 0.02), "shin.R"),
]
CLIPS = {
    "Idle": idle({"chest": (1.5, 0, 0), "head": (-1.5, 0, 0), "upper_arm.L": (0, 2, 0), "upper_arm.R": (-1.5, 0, 0)}),
    # The halberd is carried just clear of the ground.
    "Walk": walk(20, {"forearm.R": (-9, 0, 0), "hand.R": (9, 0, 0)}),
    # The halberd goes back over the shoulder and chops down ahead at frame 13.
    "Attack": [
        (0, REST),
        (8, {"spine": (-4, 0, -6), "chest": (-6, 0, -10), "head": (8, 0, 14), "upper_arm.R": (-72, 0, 0), "forearm.R": (-28, 0, 0), "hand.R": (66, 0, 0), "upper_arm.L": (-14, 0, 0)}),
        (10, {"spine": (-5, 0, -7), "chest": (-7, 0, -12), "head": (9, 0, 16), "upper_arm.R": (-78, 0, 0), "forearm.R": (-32, 0, 0), "hand.R": (68, 0, 0), "upper_arm.L": (-16, 0, 0)}),
        (13, {"spine": (10, 0, 6), "chest": (16, 0, 10), "head": (-20, 0, -14), "upper_arm.R": (-66, 0, 0), "forearm.R": (42, 0, 0), "hand.R": (48, 0, 0), "upper_arm.L": (18, 0, 0), "thigh.L": (-8, 0, 0), "shin.L": (8, 0, 0)}),
        (16, {"spine": (9, 0, 5), "chest": (14, 0, 8), "head": (-18, 0, -12), "upper_arm.R": (-60, 0, 0), "forearm.R": (40, 0, 0), "hand.R": (44, 0, 0), "upper_arm.L": (16, 0, 0), "thigh.L": (-7, 0, 0), "shin.L": (7, 0, 0)}),
        (26, REST),
    ],
    # Hold for Inspection: the shield is swung round to the front and driven forward at frame 13.
    "Cast": [
        (0, REST),
        (8, {"spine": (-3, 0, 8), "chest": (-4, 0, 14), "head": (0, 0, -20), "upper_arm.L": (-20, 0, 60), "forearm.L": (-20, 0, 0)}),
        (13, {"spine": (8, 0, -10), "chest": (12, 0, -20), "head": (-14, 0, 28), "upper_arm.L": (-70, 0, 80), "forearm.L": (-30, 0, 0), "thigh.L": (-12, 0, 0), "shin.L": (12, 0, 0)}),
        (16, {"spine": (7, 0, -9), "chest": (10, 0, -18), "head": (-12, 0, 26), "upper_arm.L": (-64, 0, 78), "forearm.L": (-28, 0, 0), "thigh.L": (-10, 0, 0), "shin.L": (10, 0, 0)}),
        (28, REST),
    ],
}
