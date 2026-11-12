# Boilerman Hask: a heavy figure whose hammer stands on the ground in his right hand, a tank on his back.
# The middle of his body is 0.055 m to the left of the middle of the model, which the hammer widens.
X = 0.055
BONES = [
    ("hips", (X, 0.03, 0.43), (X, 0.03, 0.52), None),
    ("spine", (X, 0.03, 0.52), (X, 0.03, 0.64), "hips"),
    ("chest", (X, 0.03, 0.64), (X, 0.02, 0.77), "spine"),
    ("head", (X, 0, 0.77), (X, -0.01, 0.92), "chest"),
    ("tank", (X + 0.205, 0.2, 0.78), (X + 0.205, 0.2, 0.95), "chest"),
    ("upper_arm.R", (X - 0.183, 0.02, 0.70), (X - 0.27, -0.05, 0.53), "chest"),
    ("forearm.R", (X - 0.27, -0.05, 0.53), (X - 0.3625, -0.195, 0.60), "upper_arm.R"),
    # The hammer: its head and upper shaft turn with the hand, the lower shaft follows.
    ("hand.R", (X - 0.3625, -0.195, 0.60), (X - 0.3625, -0.195, 0.92), "forearm.R"),
    ("shaft.R", (X - 0.3625, -0.195, 0.60), (X - 0.3625, -0.195, 0.03), "hand.R"),
    ("upper_arm.L", (X + 0.185, 0.02, 0.70), (X + 0.30, -0.05, 0.53), "chest"),
    ("forearm.L", (X + 0.30, -0.05, 0.53), (X + 0.31, -0.11, 0.38), "upper_arm.L"),
    ("hand.L", (X + 0.31, -0.11, 0.38), (X + 0.31, -0.125, 0.29), "forearm.L"),
    ("thigh.L", (X + 0.095, 0.03, 0.43), (X + 0.155, -0.015, 0.26), "hips"),
    ("shin.L", (X + 0.155, -0.015, 0.26), (X + 0.215, 0.01, 0.08), "thigh.L"),
    ("foot.L", (X + 0.215, 0.01, 0.08), (X + 0.225, -0.11, 0.03), "shin.L"),
    ("thigh.R", (X - 0.095, 0.03, 0.43), (X - 0.175, -0.015, 0.26), "hips"),
    ("shin.R", (X - 0.175, -0.015, 0.26), (X - 0.22, 0.01, 0.08), "thigh.R"),
    ("foot.R", (X - 0.22, 0.01, 0.08), (X - 0.23, -0.11, 0.03), "shin.R"),
]
CLIPS = {
    "Idle": idle({"chest": (1.5, 0, 0), "head": (-1.5, 0, 0), "upper_arm.L": (0, 3, 0), "upper_arm.R": (-1.5, 0, 0), "tank": (-1, 0, 0)}),
    # The hammer is carried just clear of the ground.
    "Walk": walk(24, {"forearm.R": (-11, 0, 0), "hand.R": (11, 0, 0)}),
    # The hammer goes back over the shoulder, comes down ahead at frame 13, and returns to the ground.
    "Attack": [
        (0, REST),
        (8, {"spine": (-4, 0, -6), "chest": (-6, 0, -10), "head": (8, 0, 14), "upper_arm.R": (-70, 0, 0), "forearm.R": (-30, 0, 0), "hand.R": (70, 0, 0), "upper_arm.L": (-22, 0, 0)}),
        (10, {"spine": (-5, 0, -7), "chest": (-7, 0, -12), "head": (9, 0, 16), "upper_arm.R": (-76, 0, 0), "forearm.R": (-34, 0, 0), "hand.R": (72, 0, 0), "upper_arm.L": (-25, 0, 0)}),
        (13, {"spine": (10, 0, 6), "chest": (18, 0, 10), "head": (-22, 0, -14), "upper_arm.R": (-68, 0, 0), "forearm.R": (45, 0, 0), "hand.R": (50, 0, 0), "upper_arm.L": (30, 0, 0), "thigh.L": (-8, 0, 0), "shin.L": (8, 0, 0)}),
        (16, {"spine": (9, 0, 5), "chest": (16, 0, 8), "head": (-20, 0, -12), "upper_arm.R": (-62, 0, 0), "forearm.R": (42, 0, 0), "hand.R": (46, 0, 0), "upper_arm.L": (26, 0, 0), "thigh.L": (-7, 0, 0), "shin.L": (7, 0, 0)}),
        (26, REST),
    ],
    # The hammer is lifted upright and its foot driven into the ground at frame 17.
    "Cast": [
        (0, REST),
        (9, {"chest": (-6, 0, 0), "head": (-10, 0, 0), "upper_arm.R": (-55, 0, 0), "forearm.R": (-40, 0, 0), "hand.R": (101, 0, 0), "upper_arm.L": (-20, 12, 0), "forearm.L": (-50, 0, 0)}),
        (14, {"chest": (-7, 0, 0), "head": (-12, 0, 0), "upper_arm.R": (-58, 0, 0), "forearm.R": (-42, 0, 0), "hand.R": (107, 0, 0), "upper_arm.L": (-22, 12, 0), "forearm.L": (-54, 0, 0)}),
        (17, {"chest": (6, 0, 0), "head": (-4, 0, 0), "upper_arm.R": (4, 0, 0), "forearm.R": (2, 0, 0), "hand.R": (-12, 0, 0), "upper_arm.L": (8, 0, 0)}),
        (28, REST),
    ],
}
