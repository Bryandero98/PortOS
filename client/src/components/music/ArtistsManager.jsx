import { useParams } from 'react-router';
import PersonaMasterDetail from '../persona/PersonaMasterDetail';
import {
  listArtists, createArtist, updateArtist, deleteArtist, generateImage,
  ARTIST_NAME_MAX, ARTIST_GENRE_MAX, ARTIST_BIO_MAX, ARTIST_MUSICAL_STYLE_MAX,
  ARTIST_PHYSICAL_DESCRIPTION_MAX, ARTIST_PORTRAIT_STYLE_MAX, ARTIST_PORTRAIT_IMAGE_URL_MAX,
} from '../../services/api';

const FIELDS = [
  { key: 'name', label: 'Name', placeholder: 'Nova Vale', maxLength: ARTIST_NAME_MAX },
  {
    key: 'genre', label: 'Genre', hint: "Primary genre(s) — e.g. 'indie folk, dream pop'.",
    placeholder: 'indie folk, dream pop', maxLength: ARTIST_GENRE_MAX,
  },
  {
    key: 'musicalStyle', label: 'Musical style', type: 'textarea', rows: 4,
    hint: 'Voice / production / instrumentation notes — fed into music-gen prompts.',
    placeholder: 'Warm fingerpicked guitar, breathy close-mic vocals, tape saturation, sparse reverb.', maxLength: ARTIST_MUSICAL_STYLE_MAX,
  },
  {
    key: 'bio', label: 'Bio', type: 'textarea', rows: 4, hint: 'About-the-artist blurb.',
    placeholder: 'Nova Vale is a songwriter working at the seam of folk and ambient…', maxLength: ARTIST_BIO_MAX,
  },
  {
    key: 'physicalDescription', label: 'Physical description', type: 'textarea', rows: 3,
    hint: 'Subject of the portrait — appearance, age, expression, wardrobe.',
    placeholder: 'Androgynous figure, late 20s, cropped platinum hair, vintage band tee, calm gaze.', maxLength: ARTIST_PHYSICAL_DESCRIPTION_MAX,
  },
  {
    key: 'portraitStyle', label: 'Portrait style', type: 'textarea', rows: 3,
    hint: 'Art / photography direction for the portrait render.',
    placeholder: 'Moody film photograph, neon backlight, grainy 35mm, shallow depth of field.', maxLength: ARTIST_PORTRAIT_STYLE_MAX,
  },
];

const PORTRAIT = {
  label: 'Portrait', fieldLabel: 'Portrait image', imageKey: 'portraitImageUrl',
  descriptionKey: 'physicalDescription', styleKey: 'portraitStyle', styleLabel: 'Portrait style',
  maxLength: ARTIST_PORTRAIT_IMAGE_URL_MAX,
  hint: 'Optional — generate from the description + style, choose or upload one via the gallery, or paste a URL.',
  generateTitle: 'Generate a portrait from the description + style',
  buildPrompt: (form) => {
    const description = form.physicalDescription.trim();
    const style = form.portraitStyle.trim();
    const subject = description ? `Music artist portrait. ${description}` : 'Music artist promotional portrait.';
    return style ? `${subject} ${style}` : subject;
  },
};

export default function ArtistsManager() {
  const { id } = useParams();
  return (
    <PersonaMasterDetail
      basePath="/music/artists"
      selectedId={id}
      intro="Artist personas are reusable across albums and tracks — the byline plus the genre, musical style, bio, and the physical description + style used to generate (or upload) an artist portrait."
      singular="Artist"
      plural="Artists"
      fields={FIELDS}
      listSecondaryKey="genre"
      portrait={PORTRAIT}
      listRecords={listArtists}
      createRecord={createArtist}
      updateRecord={updateArtist}
      deleteRecord={deleteArtist}
      generateImage={generateImage}
    />
  );
}
