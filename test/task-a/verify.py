"""Check Task A behavior and documentation against the fixed instruction."""
import os
import re

from flask.helpers import get_debug_flag


for value in ["", "0", "false", "FALSE", "no", "NO", "off", "OFF", "Off", "n", "N"]:
    os.environ["FLASK_DEBUG"] = value
    assert get_debug_flag() is False, repr(value)

for value in ["1", "true", "yes", "on", "debug"]:
    os.environ["FLASK_DEBUG"] = value
    assert get_debug_flag() is True, repr(value)

os.environ.pop("FLASK_DEBUG", None)
assert get_debug_flag() is False

doc = (get_debug_flag.__doc__ or "").lower()
for value in ["0", "false", "no", "off", "n"]:
    assert re.search(r"(?<!\w)" + re.escape(value) + r"(?!\w)", doc), f"Docstring must list {value!r}."
assert re.search(r"\bempty\b|\"\"|''", doc), "Docstring must include the empty-string false case."
assert re.search(r"\bunset\b|\bnot set\b|\bmissing\b|\bdefault\b", doc), "Docstring must describe the unset/default case."

print("False/true/unset matrix and docstring coverage passed.")
print(get_debug_flag.__doc__)
