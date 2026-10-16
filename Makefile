.PHONY: all test install legacy clean
all:
	cmake -S c -B c/build -DCMAKE_BUILD_TYPE=Release
	cmake --build c/build --parallel 4
test: all
	ctest --test-dir c/build --output-on-failure
	python3 c/tests/integration.py
legacy:
	npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix legacy
	node legacy/prepare.mjs
install:
	bash packaging/install-native.sh
clean:
	cmake --build c/build --target clean
