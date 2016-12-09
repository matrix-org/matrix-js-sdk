#!/usr/bin/env python

"""
Outputs the body of the first entry of changelog file CHANGELOG.md
"""

import re

found_first_header = False
for line in open("CHANGELOG.md"):
    line = line.strip()
    if re.match(r"^Changes in \[.*\]", line):
        if found_first_header:
            break
        found_first_header = True
    elif not re.match(r"^=+$", line) and len(line) > 0:
        print line
