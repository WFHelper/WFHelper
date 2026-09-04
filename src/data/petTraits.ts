// Typed shim over the generated table (scripts/pets/build-pet-traits.mjs writes
// the JSON; sources are DE's PublicExport ExportFlavour plus the browse.wf
// swatch art the hex is averaged from).
import data from "./petTraits.json";

interface PetTraitName {
  en: string;
  de: string;
  zh: string;
}

interface PetColorTrait {
  name: PetTraitName;
  /** Average sRGB of the store swatch; DE ships no colour value of its own. */
  hex: string;
}

interface PetTraitTable {
  colors: Record<string, PetColorTrait>;
  patterns: Record<string, { name: PetTraitName }>;
}

export const PET_TRAITS: PetTraitTable = data;
