# Eel: a lean runner with a hooked blade low in his right hand and a cloak over his back and left shoulder.
# The blade widens the model to his right, so his body stands 0.09 m left of its middle.
X = 0.09
BONES = [
    ("hips", (X, 0.05, 0.50), (X, 0.05, 0.57), None),
    ("spine", (X, 0.05, 0.57), (X, 0.05, 0.68), "hips"),
    ("chest", (X, 0.05, 0.68), (X, 0.05, 0.80), "spine"),
    ("head", (X, 0.06, 0.80), (X, 0.06, 0.95), "chest"),
    ("cloak", (X + 0.06, 0.17, 0.78), (X + 0.11, 0.2, 0.25), "chest"),
    ("upper_arm.R", (X - 0.14, 0.05, 0.76), (X - 0.18, 0.03, 0.59), "chest"),
    ("forearm.R", (X - 0.18, 0.03, 0.59), (X - 0.215, -0.01, 0.47), "upper_arm.R"),
    # The blade runs from the hand forward and down to its hook.
    ("hand.R", (X - 0.215, -0.01, 0.47), (X - 0.42, -0.25, 0.22), "forearm.R"),
    ("upper_arm.L", (X + 0.14, 0.05, 0.76), (X + 0.195, 0.03, 0.59), "chest"),
    ("forearm.L", (X + 0.195, 0.03, 0.59), (X + 0.22, 0.0, 0.47), "upper_arm.L"),
    ("hand.L", (X + 0.22, 0.0, 0.47), (X + 0.225, -0.01, 0.40), "forearm.L"),
    ("thigh.L", (X + 0.08, 0.05, 0.47), (X + 0.125, 0.03, 0.27), "hips"),
    ("shin.L", (X + 0.125, 0.03, 0.27), (X + 0.165, 0.06, 0.07), "thigh.L"),
    ("foot.L", (X + 0.165, 0.06, 0.07), (X + 0.185, -0.04, 0.02), "shin.L"),
    ("thigh.R", (X - 0.08, 0.05, 0.47), (X - 0.135, 0.03, 0.27), "hips"),
    ("shin.R", (X - 0.135, 0.03, 0.27), (X - 0.16, 0.06, 0.07), "thigh.R"),
    ("foot.R", (X - 0.16, 0.06, 0.07), (X - 0.18, -0.04, 0.02), "shin.R"),
]
CLIPS = {
    "Idle": idle({"chest": (1.5, 0, 2), "head": (-1.5, 0, -2), "upper_arm.R": (-3, 0, 0), "cloak": (2, 0, 0)}),
    "Walk": walk(30, {"upper_arm.R": (-10, 0, 0), "cloak": (-8, 0, 0)}),
    # The blade goes up over the right shoulder and cuts down across the body at frame 9.
    "Attack": [
        (0, REST),
        (6, {"spine": (-3, 0, -8), "chest": (-5, 0, -14), "head": (5, 0, 20), "upper_arm.R": (-115, 0, 0), "forearm.R": (-25, 0, 0), "upper_arm.L": (10, 0, 0), "cloak": (6, 0, 0)}),
        (9, {"spine": (8, 0, 8), "chest": (14, 0, 16), "head": (-18, 0, -22), "upper_arm.R": (-62, 0, 25), "forearm.R": (20, 0, 0), "hand.R": (25, 0, 0), "upper_arm.L": (25, 0, 0), "thigh.R": (-14, 0, 0), "shin.R": (14, 0, 0), "cloak": (-14, 0, 0)}),
        (12, {"spine": (10, 0, 12), "chest": (16, 0, 24), "head": (-20, 0, -32), "upper_arm.R": (-25, 0, 45), "forearm.R": (25, 0, 0), "hand.R": (35, 0, 0), "upper_arm.L": (32, 0, 0), "thigh.R": (-14, 0, 0), "shin.R": (14, 0, 0), "cloak": (-10, 0, 0)}),
        (22, REST),
    ],
    # Undertow: the free hand reaches out and drags back down at frame 14.
    "Cast": [
        (0, REST),
        (9, {"chest": (-8, 0, 10), "head": (0, 0, -10), "upper_arm.L": (-105, 0, 0), "forearm.L": (-20, 0, 0), "upper_arm.R": (20, 0, 0), "cloak": (8, 0, 0)}),
        (14, {"spine": (8, 0, 0), "chest": (14, 0, -6), "head": (-14, 0, 6), "upper_arm.L": (-30, 0, 0), "forearm.L": (-45, 0, 0), "upper_arm.R": (-10, 0, 0), "cloak": (-12, 0, 0)}),
        (26, REST),
    ],
}
