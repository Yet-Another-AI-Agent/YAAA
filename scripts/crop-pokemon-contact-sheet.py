#!/usr/bin/env python3
"""Crop the one-time 5x10 avatar contact sheet into the shipped avatar cache."""

from pathlib import Path
from PIL import Image

SOURCE = Path(__file__).resolve().parents[1] / "packages/agents/assets/pokemon-contact-sheet.png"
OUT = Path(__file__).resolve().parents[1] / "packages/agents/assets/pokemon-avatars"
NAMES = [
    "Pikachu", "Charizard", "Bulbasaur", "Squirtle", "Jigglypuff", "Eevee", "Snorlax", "Mewtwo", "Gengar", "Lucario",
    "Greninja", "Dragonite", "Gardevoir", "Blastoise", "Venusaur", "Rayquaza", "Togepi", "Mudkip", "Torchic", "Treecko",
    "Lugia", "Ho-Oh", "Psyduck", "Meowth", "Gyarados", "Lapras", "Machamp", "Alakazam", "Umbreon", "Espeon",
    "Sylveon", "Arcanine", "Scyther", "Tyranitar", "Salamence", "Metagross", "Garchomp", "Blaziken", "Decidueye", "Mimikyu",
    "Ditto", "Cubone", "Vulpix", "Ninetales", "Articuno", "Zapdos", "Moltres", "Celebi", "Jirachi", "Mascot",
]


def slug(name: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in name).strip("-")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as sheet:
        # The supplied artwork is a 10x5 card grid inside a larger tabletop
        # scene. Crop the card grid first so the title and background never
        # become agent avatars.
        # Coordinates are for the supplied 2752x1536 image.
        grid = sheet.crop((342, 264, 2422, 1499))
        width, height = grid.size
        for index, name in enumerate(NAMES):
            row, column = divmod(index, 10)
            left = round(column * width / 10)
            top = round(row * height / 5)
            right = round((column + 1) * width / 10)
            # Each card is shorter than its row pitch; leave the row gap out
            # so the next card cannot bleed into the avatar.
            bottom = top + round((height / 5) * 0.82)
            grid.crop((left, top, right, bottom)).resize((256, 256), Image.Resampling.LANCZOS).save(
                OUT / f"{slug(name)}.png", optimize=True
            )


if __name__ == "__main__":
    main()
