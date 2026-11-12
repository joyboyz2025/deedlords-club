# Flare Gunner Ko: a broad gunner, a flare pistol hanging muzzle-down ahead of his right hand, a bedroll on his back.
BONES = [
    ("hips", (0, 0.045, 0.47), (0, 0.045, 0.55), None),
    ("spine", (0, 0.045, 0.55), (0, 0.045, 0.67), "hips"),
    ("chest", (0, 0.045, 0.67), (0, 0.04, 0.82), "spine"),
    ("head", (0, 0.02, 0.82), (0, 0.02, 0.97), "chest"),
    ("pack", (0.1, 0.2, 0.72), (0.15, 0.22, 0.90), "chest"),
    ("upper_arm.R", (-0.165, 0.04, 0.80), (-0.25, 0.02, 0.59), "chest"),
    ("forearm.R", (-0.25, 0.02, 0.59), (-0.235, -0.12, 0.46), "upper_arm.R"),
    # The hand and the pistol, to its muzzle.
    ("hand.R", (-0.235, -0.12, 0.46), (-0.21, -0.25, 0.27), "forearm.R"),
    ("upper_arm.L", (0.17, 0.04, 0.80), (0.25, 0.08, 0.59), "chest"),
    ("forearm.L", (0.25, 0.08, 0.59), (0.255, 0.08, 0.48), "upper_arm.L"),
    ("hand.L", (0.255, 0.08, 0.48), (0.26, 0.07, 0.40), "forearm.L"),
    ("thigh.L", (0.09, 0.04, 0.47), (0.13, 0.02, 0.28), "hips"),
    ("shin.L", (0.13, 0.02, 0.28), (0.16, 0.05, 0.095), "thigh.L"),
    ("foot.L", (0.16, 0.05, 0.095), (0.2, -0.07, 0.02), "shin.L"),
    ("thigh.R", (-0.09, 0.04, 0.47), (-0.12, 0.02, 0.29), "hips"),
    ("shin.R", (-0.12, 0.02, 0.29), (-0.165, 0.05, 0.095), "thigh.R"),
    ("foot.R", (-0.165, 0.05, 0.095), (-0.2, -0.07, 0.02), "shin.R"),
]
AIM = {"chest": (0, 0, 8), "head": (0, 0, -8), "upper_arm.R": (-48, 0, 0), "forearm.R": (-12, 0, 0), "upper_arm.L": (8, 0, 0)}
UP = {"chest": (-6, 0, 0), "head": (-16, 0, 0), "upper_arm.R": (-130, 0, 0), "forearm.R": (-17, 0, 0), "upper_arm.L": (10, 0, 0)}
CLIPS = {
    "Idle": idle({"chest": (1.5, 0, 0), "head": (-1.5, 0, 0), "upper_arm.R": (-2, 0, 0), "pack": (-1, 0, 0)}),
    "Walk": walk(22, {"upper_arm.R": (-6, 0, 0)}),
    # The pistol comes level, kicks at frame 8, and drops.
    "Attack": [
        (0, REST),
        (5, AIM),
        (7, AIM),
        (8, {"spine": (-3, 0, 0), "chest": (-6, 0, 6), "head": (4, 0, -6), "upper_arm.R": (-56, 0, 0), "forearm.R": (-30, 0, 0), "upper_arm.L": (12, 0, 0)}),
        (11, AIM),
        (20, REST),
    ],
    # Signal Flare: the pistol is fired straight up at frame 12.
    "Cast": [
        (0, REST),
        (9, UP),
        (11, UP),
        (12, {**UP, "upper_arm.R": (-118, 0, 0), "forearm.R": (-4, 0, 0), "spine": (3, 0, 0)}),
        (15, UP),
        (28, REST),
    ],
}
