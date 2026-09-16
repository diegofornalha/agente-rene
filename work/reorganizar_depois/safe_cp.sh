#!/usr/bin/env bash
# safe_cp <src> <dst> : copy without overwriting; append " (N)" before ext on collision
src="$1"; dst="$2"
if [ ! -e "$src" ]; then echo "MISSING_SRC: $src"; exit 3; fi
if [ ! -e "$dst" ]; then cp "$src" "$dst" && echo "OK: $dst"; exit 0; fi
base="${dst%.*}"; ext="${dst##*.}"
n=2
while [ -e "${base} (${n}).${ext}" ]; do n=$((n+1)); done
cp "$src" "${base} (${n}).${ext}" && echo "OK(dup): ${base} (${n}).${ext}"
