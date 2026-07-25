"""Run trellis-mac's generate.py with its supported 4K baker exposed.

Microsoft TRELLIS.2's texture exporter accepts arbitrary atlas sizes and its
official app exposes 4096, but trellis-mac's argparse wrapper caps the same
exporter at 2048. PortOS uses this tiny adapter only for the high-memory 4K lane;
all model loading, sampling, UV unwrapping, baking, and export remain upstream.
"""

import argparse
import runpy
import sys


UPSTREAM_TEXTURE_SIZES = [512, 1024, 2048]
PORTOS_TEXTURE_SIZES = [*UPSTREAM_TEXTURE_SIZES, 4096]


def main():
    if len(sys.argv) < 2:
        raise RuntimeError("trellis2GenerateRunner.py requires the upstream generate.py path")

    generate_script = sys.argv[1]
    original_add_argument = argparse.ArgumentParser.add_argument

    def add_argument(parser, *name_or_flags, **kwargs):
        if "--texture-size" in name_or_flags:
            if kwargs.get("choices") != UPSTREAM_TEXTURE_SIZES:
                raise RuntimeError(
                    "trellis-mac changed its texture-size interface; "
                    "the PortOS 4K adapter needs to be updated"
                )
            kwargs = {**kwargs, "choices": PORTOS_TEXTURE_SIZES}
        return original_add_argument(parser, *name_or_flags, **kwargs)

    argparse.ArgumentParser.add_argument = add_argument
    sys.argv = [generate_script, *sys.argv[2:]]
    runpy.run_path(generate_script, run_name="__main__")


if __name__ == "__main__":
    main()
