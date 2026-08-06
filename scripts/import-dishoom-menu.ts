/**
 * Replace Sync2Dine Demo Kitchen menu with a full Dishoom (Bombay café) menu.
 * Source: Dishoom Shoreditch all-day + breakfast + puddings (public menus).
 *
 * Usage:
 *   npm run seed:dishoom
 *   npx tsx --env-file=.env scripts/import-dishoom-menu.ts
 */
import { createClient } from '@supabase/supabase-js';

const DEMO_KITCHEN_ORG_ID = 'c2887ddb-0cba-4df1-9086-e7399c92d159';
const ORG_NAME = 'Sync2Dine Demo Kitchen';
const ALLERGEN_NOTES = 'Demo import — verify allergens before service';

type MenuSeed = {
  id: string;
  name: string;
  sellPrice: number;
  category: 'starters' | 'mains' | 'sides' | 'drinks' | 'desserts' | 'specials' | 'other';
  description?: string;
  allergensContains?: string[];
  allergensMayContain?: string[];
  dietary?: string[];
};

const MENU: MenuSeed[] = [
  // ?? Café Special ??????????????????????????????????????????????????????????
  {
    id: 'dishoom-prawn-pathia',
    name: 'Prawn Pathia',
    sellPrice: 25.5,
    category: 'specials',
    description:
      'Succulent prawns marinated overnight in ginger, garlic and lime, lightly charred then nestled in a fiery-sweet-tangy tomato masala. With onion salad and Roomali Roti. Best when shared.',
    allergensContains: ['crustaceans', 'gluten'],
  },

  // ?? At lunch, and later ? starters / mains ???????????????????????????????
  {
    id: 'dishoom-chole-puri-halwa',
    name: 'Chole Puri Halwa',
    sellPrice: 16.1,
    category: 'mains',
    description:
      'Chole (chickpeas), sweet semolina halwa, pickles and one giant crackled puffy puri. Satisfying morning, noon or night.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-chilli-broccoli-salad',
    name: 'Chilli Broccoli Salad',
    sellPrice: 14.9,
    category: 'starters',
    description:
      'Toasted pistachios and shredded mint with greenest broccoli, fresh red chillies, pumpkin and sunflower seeds, dates and lime.',
    allergensContains: ['nuts'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-malai-chicken-salad',
    name: 'Malai Chicken Salad',
    sellPrice: 15.2,
    category: 'starters',
    description:
      'Creamy charred chicken, leafy greens, sprouted beans, bulgur wheat, vegetable fiddlesticks, toasty coconut and tarty curry-leaf dressing.',
    allergensContains: ['gluten', 'milk'],
  },
  {
    id: 'dishoom-paneer-roomali-roll',
    name: 'Paneer Roomali Roll',
    sellPrice: 12.6,
    category: 'starters',
    description:
      'Delicate handkerchief roll crisped and filled with grilled paneer, onion, peppers and green leaves. Mint chutney on the side.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-chicken-kathi-roll',
    name: 'Chicken Kathi Roll',
    sellPrice: 12.8,
    category: 'starters',
    description:
      'Flaky paratha with a fine omelette layer, wrapped around chicken tikka, fresh kachumber and zingy green chutney.',
    allergensContains: ['gluten', 'eggs', 'milk'],
  },
  {
    id: 'dishoom-vada-pau',
    name: 'Vada Pau',
    sellPrice: 7.2,
    category: 'starters',
    description:
      'Bombay street staple: hot potato vada, crunchy titbits and chutneys tucked inside a soft home-made bun. Sprinkle red spicy masala to taste.',
    allergensContains: ['gluten'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-bun-maska-chai',
    name: 'Bun Maska Chai',
    sellPrice: 5.7,
    category: 'starters',
    description: 'The Irani café classic. Soft bun with butter inside, to be dipped happily into the hot chai.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },

  // ?? Snack ????????????????????????????????????????????????????????????????
  {
    id: 'dishoom-chote-papad',
    name: 'Chote Papad With Mango Chutney',
    sellPrice: 5.1,
    category: 'starters',
    description: "Poppadoms torn, then fried ’til crisp. Flecked with green chilli. Best dipped into home-made mango chutney.",
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },

  // ?? Small Plates ?????????????????????????????????????????????????????????
  {
    id: 'dishoom-keema-pau',
    name: 'Keema Pau',
    sellPrice: 11.2,
    category: 'starters',
    description:
      'Earthy aromatic minced lamb studded with peas, subtle dill and warming lindi pepper. With toasted buttered pau.',
    allergensContains: ['gluten', 'milk'],
  },
  {
    id: 'dishoom-chilli-chicken',
    name: 'Chilli Chicken',
    sellPrice: 11.2,
    category: 'starters',
    description: 'Crispy garlic-ginger-soy-chilli chicken — a modern Irani café Indo-Chinese staple.',
    allergensContains: ['soya', 'gluten'],
  },
  {
    id: 'dishoom-vegetable-samosas',
    name: 'Vegetable Samosas',
    sellPrice: 7.7,
    category: 'starters',
    description:
      'Crunchy Punjabi-style shortcrust pastry, pea and potato filling warmly spiced with cinnamon. Tamarind chutney for dipping.',
    allergensContains: ['gluten'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-lamb-samosas',
    name: 'Lamb Samosas',
    sellPrice: 8.2,
    category: 'starters',
    description: 'Gujarati filo stuffed with minced lamb, onions and spices.',
    allergensContains: ['gluten'],
  },
  {
    id: 'dishoom-okra-fries',
    name: 'Okra Fries',
    sellPrice: 7.7,
    category: 'starters',
    description: "Fine lady's fingers for the fingers.",
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-chilli-cheese-toast',
    name: 'Chilli Cheese Toast',
    sellPrice: 7.5,
    category: 'starters',
    description: 'Green chillies, capsicum and garlic in Cheddar melt on white sliced loaf.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-prawn-koliwada',
    name: 'Prawn Koliwada',
    sellPrice: 10.9,
    category: 'starters',
    description: "Bombay's Koli Wada recipe: a bowl of delicate crispy morsels — perfect for chutney-dipping.",
    allergensContains: ['crustaceans', 'gluten'],
  },
  {
    id: 'dishoom-pau-bhaji',
    name: 'Pau Bhaji',
    sellPrice: 8.5,
    category: 'starters',
    description: 'Buttery-spicy mashed vegetables and home-made buns on a Chowpatty tray. No food is more Bombay.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-house-chaat',
    name: 'Dishoom House Chaat',
    sellPrice: 10.5,
    category: 'starters',
    description:
      'Warm-cold, sweet-tangy: golden-fried sweet potato with cool yoghurt, pomegranate, beetroot, radish and carrot. Tamarind drizzle and green chutney.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-bhel',
    name: 'Bhel',
    sellPrice: 8.2,
    category: 'starters',
    description:
      'Cold and crunchy: puffed rice, peanuts and Bombay Mix tossed with fresh pomegranate, tomato, onion, lime, tamarind and mint.',
    allergensContains: ['peanuts'],
    dietary: ['vegan', 'vegetarian'],
  },

  // ?? Grills ???????????????????????????????????????????????????????????????
  {
    id: 'dishoom-murgh-malai',
    name: 'Murgh Malai',
    sellPrice: 14.7,
    category: 'mains',
    description:
      'Chicken thigh steeped overnight in garlic, ginger, coriander stems and a little cream. Slightly pink when fully cooked.',
    allergensContains: ['milk'],
  },
  {
    id: 'dishoom-charred-lamb-chops',
    name: 'Charred Lamb Chops',
    sellPrice: 19.9,
    category: 'mains',
    description:
      'Two generous chops marinated overnight in raw papaya, yoghurt and spices. Blackened on the grill with Kashmiri chilli sauce.',
    allergensContains: ['milk'],
  },
  {
    id: 'dishoom-chicken-tikka',
    name: 'Dishoom Chicken Tikka',
    sellPrice: 14.7,
    category: 'mains',
    description:
      'A family recipe using a marinade of sweet vinegar (not yoghurt). Laced with ginger, turmeric, garlic and green chilli.',
    allergensContains: [],
  },
  {
    id: 'dishoom-masala-prawns',
    name: 'Masala Prawns',
    sellPrice: 18.2,
    category: 'mains',
    description: 'Each one charred slightly at the edges, succulent and simple.',
    allergensContains: ['crustaceans'],
  },
  {
    id: 'dishoom-sheekh-kabab',
    name: 'Sheekh Kabab',
    sellPrice: 14.7,
    category: 'mains',
    description: 'Minced lamb marinated with green chilli, coriander and cumin, then grilled.',
    allergensContains: [],
  },
  {
    id: 'dishoom-makhmali-paneer',
    name: 'Makhmali Paneer',
    sellPrice: 14.2,
    category: 'mains',
    description:
      'Pillows of paneer, marinated, charred and spiced gently. A flourish of fried cashews and pomegranate. Makhmali means velvety.',
    allergensContains: ['milk', 'nuts'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-gunpowder-potatoes',
    name: 'Gunpowder Potatoes',
    sellPrice: 10.5,
    category: 'sides',
    description:
      'New potatoes smoky-grilled, broken apart, tossed with butter, crushed aromatic seeds and green herbs.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-saffron-cauliflower',
    name: 'Saffron Cauliflower',
    sellPrice: 11.2,
    category: 'sides',
    description: 'Glowing golden, hot from the grill. Soft, buttery magnificence with warm masala tingles.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },

  // ?? Ruby Murray (curries) ????????????????????????????????????????????????
  {
    id: 'dishoom-chicken-ruby',
    name: 'Chicken Ruby',
    sellPrice: 18.9,
    category: 'mains',
    description: 'Tender chicken in a rich, silky makhani sauce. A good and proper curry redolent with spice and flavour.',
    allergensContains: ['milk', 'nuts'],
  },
  {
    id: 'dishoom-goan-monkfish-curry',
    name: 'Goan Monkfish Curry',
    sellPrice: 19.9,
    category: 'mains',
    description:
      'Choicest monkfish simmered in creamy coconut, tamarind, tomatoes and kokum. Strewn with fragrant curry leaves.',
    allergensContains: ['fish'],
  },
  {
    id: 'dishoom-mutton-pepper-fry',
    name: 'Mutton Pepper Fry',
    sellPrice: 20.2,
    category: 'mains',
    description:
      'Finest mutton marinated in red chilli, ginger and garlic, then cooked with black peppercorns and whole spices. Robust, spicy and tender.',
    allergensContains: [],
  },
  {
    id: 'dishoom-mattar-paneer',
    name: 'Mattar Paneer',
    sellPrice: 17.5,
    category: 'mains',
    description: 'A steadfast, humble and delicious vegetarian curry, beloved of Bombay families.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-house-black-daal',
    name: 'House Black Daal',
    sellPrice: 11.2,
    category: 'mains',
    description: 'A Dishoom signature — dark, rich, deeply flavoured. Cooked over 24 hours for extra harmony.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },

  // ?? Biryani and Rice ?????????????????????????????????????????????????????
  {
    id: 'dishoom-lamb-biryani',
    name: 'Lamb Biryani',
    sellPrice: 21.0,
    category: 'mains',
    description:
      'Fall-apart leg of lamb bedded in a pot with buttery saffron rice, caramelised onions, rich stock and warming spices. Best with raita.',
    allergensContains: ['milk'],
  },
  {
    id: 'dishoom-chicken-berry-britannia',
    name: 'Chicken Berry Britannia',
    sellPrice: 18.9,
    category: 'mains',
    description:
      'Chicken, ginger, garlic, mint, coriander and rice cooked together in the Kacchi style. An homage to Britannia’s Chicken Berry Pulao, with cranberries.',
    allergensContains: [],
  },
  {
    id: 'dishoom-awadhi-jackfruit-biryani',
    name: 'Awadhi Jackfruit Biryani',
    sellPrice: 17.9,
    category: 'mains',
    description:
      'Sturdy savoury jackfruit and delicately flavoured rice, potted, sealed and cooked the traditional way. Adorned with barberries and sultanas.',
    allergensContains: [],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-steamed-basmati-rice',
    name: 'Steamed Basmati Rice',
    sellPrice: 5.0,
    category: 'sides',
    description: 'It means “the fragrant one”.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },

  // ?? Veg. side dishes ?????????????????????????????????????????????????????
  {
    id: 'dishoom-chilli-broccoli-salad-half',
    name: 'Chilli Broccoli Salad (Half Portion)',
    sellPrice: 8.5,
    category: 'sides',
    description: 'Half portion of the chilli broccoli salad with pistachios, mint, seeds, dates and lime.',
    allergensContains: ['nuts'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-grilled-greens',
    name: 'Grilled Greens',
    sellPrice: 7.5,
    category: 'sides',
    description: 'Grilled mangetout and Tenderstem broccoli with lively Bengali mustard dressing.',
    allergensContains: ['mustard'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-chilli-butter-bhutta',
    name: 'Chilli Butter-Bhutta',
    sellPrice: 6.5,
    category: 'sides',
    description: 'Corn-on-the-cob brushed with butter and grilled over charcoal. Finished with chilli, salt and lime, Chowpatty style.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-kachumber',
    name: 'Kachumber',
    sellPrice: 6.2,
    category: 'sides',
    description: 'A messy to-do of cucumber, onion and tomato. A little lime lifts the whole affair.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-warm-aubergine-chutney',
    name: 'Warm Aubergine Chutney',
    sellPrice: 3.9,
    category: 'sides',
    description: 'A rare embellishment of sweet and sour and spice. A little goes a long way.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-raita',
    name: 'Raita',
    sellPrice: 5.5,
    category: 'sides',
    description: 'Delicate minty yoghurt, cool as a cucumber.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },

  // ?? Bread ????????????????????????????????????????????????????????????????
  {
    id: 'dishoom-plain-naan',
    name: 'Plain Naan',
    sellPrice: 5.2,
    category: 'sides',
    description: 'Freshly baked in the tandoor.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-garlic-naan',
    name: 'Garlic Naan',
    sellPrice: 5.5,
    category: 'sides',
    description: 'With minced garlic and coriander sprinkle.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-cheese-naan',
    name: 'Cheese Naan',
    sellPrice: 6.4,
    category: 'sides',
    description: 'Cheddar is melted inside.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-masala-paratha',
    name: 'Masala Paratha',
    sellPrice: 5.6,
    category: 'sides',
    description: 'Wholewheat flaky-buttery bread from the tandoor, with chaat masala and dried mint.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-roomali-roti',
    name: 'Roomali Roti',
    sellPrice: 5.2,
    category: 'sides',
    description: 'Soft handkerchief-thin bread, thrown, stretched and griddled to order on an upturned tawa.',
    allergensContains: ['gluten'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-tandoori-roti',
    name: 'Tandoori Roti',
    sellPrice: 5.2,
    category: 'sides',
    description: 'Wholewheat bread, delicately charred from the tandoor.',
    allergensContains: ['gluten'],
    dietary: ['vegetarian'],
  },

  // ?? Cooked Breakfasts ????????????????????????????????????????????????????
  {
    id: 'dishoom-keema-per-eedu',
    name: 'Keema Per Eedu',
    sellPrice: 17.9,
    category: 'mains',
    description:
      'Parsi power breakfast: spicy chicken keema with chicken liver, topped with two runny-yolked fried eggs and salli crisp-chips. Served with home-made buns.',
    allergensContains: ['eggs', 'gluten'],
  },
  {
    id: 'dishoom-parsi-omelette',
    name: 'Parsi Omelette',
    sellPrice: 11.9,
    category: 'mains',
    description:
      'Three-egg omelette of chopped tomato, onion, coriander, green chilli and a little cheese. With grilled tomato and Fire Toast.',
    allergensContains: ['eggs', 'milk', 'gluten'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-akuri',
    name: 'Akuri',
    sellPrice: 12.2,
    category: 'mains',
    description: 'Three eggs, spiced, scrambled and piled up richly alongside plump home-made buns and grilled tomato.',
    allergensContains: ['eggs', 'gluten', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-kejriwal',
    name: 'Kejriwal',
    sellPrice: 12.7,
    category: 'mains',
    description: 'Two fried eggs on chilli cheese toast. A modern favourite of the Willingdon Club in Tardeo.',
    allergensContains: ['eggs', 'milk', 'gluten'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-the-big-bombay',
    name: 'The Big Bombay',
    sellPrice: 17.5,
    category: 'mains',
    description:
      'Abundant akuri, smoked streaky bacon, peppery pork sausages, masala beans, grilled field mushrooms, grilled tomato and buttered home-made buns.',
    allergensContains: ['eggs', 'gluten', 'milk'],
  },
  {
    id: 'dishoom-the-vegan-bombay',
    name: 'The Vegan Bombay',
    sellPrice: 17.5,
    category: 'mains',
    description:
      'Tofu akuri, crispy-smashed vegan sausages, vegan black pudding, grilled field mushrooms, masala beans, grilled tomato and home-made vegan buns.',
    allergensContains: ['soya', 'gluten'],
    dietary: ['vegan', 'vegetarian'],
  },

  // ?? Fruits, Grains & Breads ??????????????????????????????????????????????
  {
    id: 'dishoom-date-banana-porridge',
    name: 'Date & Banana Porridge',
    sellPrice: 9.2,
    category: 'desserts',
    description:
      'Organic porridge oats cooked with oat milk, banana and sweet Medjool dates. Bottomless portion — ask for more.',
    allergensContains: ['gluten'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-cinnamon-jaggery-pancakes',
    name: 'Cinnamon-Jaggery Pancakes',
    sellPrice: 12.7,
    category: 'desserts',
    description: 'Fluffy pancakes with soft vanilla cream, mixed berries and jaggery syrup spiced with chai-like warmth.',
    allergensContains: ['gluten', 'milk', 'eggs'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-fruit-yoghurt',
    name: 'Fruit & Yoghurt',
    sellPrice: 9.7,
    category: 'desserts',
    description:
      'Fresh seasonal fruits topped with creamy yoghurt infused with fresh vanilla pod. Dairy or coconut yoghurt.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-house-granola',
    name: 'House Granola',
    sellPrice: 10.5,
    category: 'desserts',
    description:
      'Handmade with toasted oats, seeds, cashews, almonds, pistachios and cinnamon. With fresh fruits and yoghurt.',
    allergensContains: ['gluten', 'nuts', 'milk'],
    dietary: ['vegetarian'],
  },

  // ?? Dishoom Naan Rolls ???????????????????????????????????????????????????
  {
    id: 'dishoom-bacon-naan-roll',
    name: 'Bacon Naan Roll',
    sellPrice: 11.7,
    category: 'starters',
    description:
      'Freshly baked naan with cream cheese, tomato-chilli jam and coriander, wrapped around Ramsay of Carluke smoked streaky bacon. A Dishoom signature.',
    allergensContains: ['gluten', 'milk'],
  },
  {
    id: 'dishoom-double-bacon-naan-roll',
    name: 'Double Bacon Naan Roll',
    sellPrice: 13.9,
    category: 'starters',
    description: 'Twice the bacon. More power to you.',
    allergensContains: ['gluten', 'milk'],
  },
  {
    id: 'dishoom-sausage-naan-roll',
    name: 'Sausage Naan Roll',
    sellPrice: 12.2,
    category: 'starters',
    description: 'Shropshire pork sausages, warmly spiced with cracked black pepper, in a freshly baked naan.',
    allergensContains: ['gluten', 'milk'],
  },
  {
    id: 'dishoom-veg-sausage-egg-naan-roll',
    name: 'Veg. Sausage & Egg Naan Roll',
    sellPrice: 13.7,
    category: 'starters',
    description:
      'Crispy-smashed veggie sausage with umami spicing and runny-yolked eggs in a freshly baked naan. Vegan option available.',
    allergensContains: ['gluten', 'eggs', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-egg-naan-roll',
    name: 'Egg Naan Roll',
    sellPrice: 10.7,
    category: 'starters',
    description: 'Two fried Cornish free-range eggs with saffron-orange runny yolks in a freshly baked naan.',
    allergensContains: ['gluten', 'eggs', 'milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-wrestlers-naan-roll',
    name: "Wrestler's Naan Roll",
    sellPrice: 14.9,
    category: 'starters',
    description: 'Smoked streaky bacon, peppery pork sausages and runny-yolked egg. Grapple with it.',
    allergensContains: ['gluten', 'eggs', 'milk'],
  },
  {
    id: 'dishoom-bacon-egg-naan-roll',
    name: 'Bacon & Egg Naan Roll',
    sellPrice: 13.2,
    category: 'starters',
    description: 'Smoked streaky bacon and runny-yolked eggs in a freshly baked naan.',
    allergensContains: ['gluten', 'eggs', 'milk'],
  },
  {
    id: 'dishoom-sausage-egg-naan-roll',
    name: 'Sausage & Egg Naan Roll',
    sellPrice: 13.7,
    category: 'starters',
    description: 'Peppery pork sausages and runny-yolked eggs in a freshly baked naan.',
    allergensContains: ['gluten', 'eggs', 'milk'],
  },
  {
    id: 'dishoom-vegan-sausage-naan-roll',
    name: 'Vegan Sausage Naan Roll',
    sellPrice: 12.9,
    category: 'starters',
    description: 'Crispy-smashed vegan sausage developed with Chef Neil Rankin, in a freshly baked naan.',
    allergensContains: ['gluten'],
    dietary: ['vegan', 'vegetarian'],
  },

  // ?? Breakfast side orders ????????????????????????????????????????????????
  {
    id: 'dishoom-masala-beans',
    name: 'Masala Beans',
    sellPrice: 5.2,
    category: 'sides',
    description: 'Spiced breakfast beans.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-grilled-mushrooms',
    name: 'Grilled Mushrooms',
    sellPrice: 5.2,
    category: 'sides',
    description: 'Grilled field mushrooms.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-two-pork-sausages',
    name: 'Two Pork Sausages',
    sellPrice: 5.2,
    category: 'sides',
    description: 'Shropshire pork sausages, warmly spiced with cracked black pepper.',
    allergensContains: [],
  },
  {
    id: 'dishoom-two-vegan-sausages',
    name: 'Two Crispy-Smashed Vegan Sausages',
    sellPrice: 5.2,
    category: 'sides',
    description: 'Crispy-smashed vegan sausages.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-four-rashers-bacon',
    name: 'Four Rashers Of Bacon',
    sellPrice: 5.2,
    category: 'sides',
    description: 'Ramsay of Carluke smoked streaky bacon.',
    allergensContains: [],
  },
  {
    id: 'dishoom-fire-toast',
    name: 'Fire Toast, Butter And Jam',
    sellPrice: 4.9,
    category: 'sides',
    description: 'Fire toast with butter and jam.',
    allergensContains: ['gluten', 'milk'],
    dietary: ['vegetarian'],
  },

  // ?? Puddings ?????????????????????????????????????????????????????????????
  {
    id: 'dishoom-basmati-kheer',
    name: 'Basmati Kheer',
    sellPrice: 9.2,
    category: 'desserts',
    description:
      'Silky caramelised basmati rice pudding with vanilla-infused coconut milk, cardamom and cashews. Layered with blueberry compôte.',
    allergensContains: ['nuts'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-coconutty-fruit-crumble',
    name: 'Coconutty Fruit Crumble',
    sellPrice: 10.2,
    category: 'desserts',
    description:
      'A medley of pineapple, apple and raspberry, crowned with toasted coconut crumble and silken coconut ice cream.',
    allergensContains: [],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-chocolate-pudding',
    name: 'Dishoom Chocolate Pudding',
    sellPrice: 10.5,
    category: 'desserts',
    description: 'Melting-in-the-middle chocolate pudding served with a scoop of Kashmiri Chilli ice cream.',
    allergensContains: ['milk', 'eggs', 'gluten'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-mango-kulfi',
    name: 'Mango Kulfi',
    sellPrice: 6.9,
    category: 'desserts',
    description: 'Satin-smooth, sweet real mango.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-pistachio-kulfi',
    name: 'Pistachio Kulfi',
    sellPrice: 6.9,
    category: 'desserts',
    description: 'Creamy, proper pistachio.',
    allergensContains: ['milk', 'nuts'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-malai-kulfi',
    name: 'Malai Kulfi',
    sellPrice: 6.9,
    category: 'desserts',
    description: 'The original with a hint of caramel.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-kala-khatta',
    name: 'Kala Khatta With Nice Cream',
    sellPrice: 7.5,
    category: 'desserts',
    description:
      'On a bed of almond mascarpone cream: fluffy ice-flakes steeped in kokum and jamun fruit syrup, blueberries, chilli, lime and black salt.',
    allergensContains: ['milk', 'nuts'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-bowl-of-ice-cream',
    name: 'A Bowl Of Ice Cream',
    sellPrice: 7.5,
    category: 'desserts',
    description: 'Cinnamon, Coconut or Kashmiri Chilli.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },

  // ?? Tipples / cocktails ??????????????????????????????????????????????????
  {
    id: 'dishoom-bella-storia-glass',
    name: 'Bella Storia Spumante (125ml)',
    sellPrice: 10.5,
    category: 'drinks',
    description: 'Organic Garganega grapes — refreshing aperitivo akin to Prosecco. Extra dry.',
    allergensContains: ['sulphites'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-bloody-gosh-mary',
    name: 'Bloody-Gosh Mary (Rocks)',
    sellPrice: 13.2,
    category: 'drinks',
    description: 'Tomato juice, Finlandia Vodka, savoury makhani sauce, warming spices and comely edibles.',
    allergensContains: [],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-virgin-mary',
    name: 'Virgin Mary (Rocks)',
    sellPrice: 9.7,
    category: 'drinks',
    description: 'Feistiness abounds, but there is no swearing.',
    allergensContains: [],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-dhoble',
    name: 'Dhoble (Rocks)',
    sellPrice: 13.3,
    category: 'drinks',
    description: 'Fresh orange and lemon juice conceal vodka, jaggery and a furtive dash of orange bitters, on ice.',
    allergensContains: [],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-babas-sesame-espresso-martini',
    name: "Baba's Sesame Espresso Martini (Up)",
    sellPrice: 12.7,
    category: 'drinks',
    description:
      "Baba’s espresso meets Finlandia Vodka, with molasses bitters, chai syrup, white sesame tincture and black sesame.",
    allergensContains: ['sesame'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-teetotal-espresso-martini',
    name: 'Teetotal Espresso Martini (Up)',
    sellPrice: 10.2,
    category: 'drinks',
    description: "Baba’s espresso with complex black cardamom, cinnamon syrup and a warm gingery kick.",
    allergensContains: [],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-naughty-chocolate-chai',
    name: 'Naughty Chocolate Chai',
    sellPrice: 10.2,
    category: 'drinks',
    description: 'Chocolate chai gone a little madcap with Slane Irish Whiskey.',
    allergensContains: [],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-permit-room-old-fashioned',
    name: 'Permit Room Old-Fashioned (Peg)',
    sellPrice: 14.9,
    category: 'drinks',
    description:
      'Coconut-washed Woodford Reserve Bourbon, Pedro Ximénez Sherry and Medjool-date liqueur. Light, strong and smooth.',
    allergensContains: [],
    dietary: ['vegetarian'],
  },

  // ?? Fresh Juice, Shots & Lassi ???????????????????????????????????????????
  {
    id: 'dishoom-fresh-orange-juice',
    name: 'Fresh Orange Juice',
    sellPrice: 6.1,
    category: 'drinks',
    description: 'No poppycock. Freshly squeezed.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-fresh-grapefruit-juice',
    name: 'Fresh Ruby-Red Grapefruit Juice',
    sellPrice: 6.7,
    category: 'drinks',
    description: 'Freshly squeezed ruby-red grapefruit.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-ginger-shot',
    name: 'Ginger Shot',
    sellPrice: 4.3,
    category: 'drinks',
    description: 'Fiery ginger-apple tonic. Put pep in your step.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-turmeric-shot',
    name: 'Turmeric Shot',
    sellPrice: 4.3,
    category: 'drinks',
    description: 'Harmonising blend of turmeric, ginger and apple.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-breakfast-lassi',
    name: 'Breakfast Lassi',
    sellPrice: 7.1,
    category: 'drinks',
    description: 'A concoction of yoghurt, banana, mango and oats. Keep regular.',
    allergensContains: ['milk', 'gluten'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-mango-fennel-lassi',
    name: 'Mango & Fennel Lassi',
    sellPrice: 6.9,
    category: 'drinks',
    description: 'First-class yoghurt-drink with mango and a sprinkling of fennel seeds.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-rose-cardamom-lassi',
    name: 'Rose & Cardamom Lassi',
    sellPrice: 6.9,
    category: 'drinks',
    description: 'Sweet and subtle as a perfumed love-letter.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-salted-lassi',
    name: 'Salted Lassi',
    sellPrice: 6.7,
    category: 'drinks',
    description: 'Creamy yoghurt, salted and gently spiced with crushed cumin.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },

  // ?? Chai / tea / doodh / coffee ??????????????????????????????????????????
  {
    id: 'dishoom-house-chai',
    name: 'House Chai',
    sellPrice: 4.8,
    category: 'drinks',
    description: 'All things nice: warming comfort and satisfying spice. Traditional or with oat milk.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-chocolate-chai',
    name: 'Chocolate Chai',
    sellPrice: 5.2,
    category: 'drinks',
    description: 'A charming couplet of dark chocolate and spicy chai.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-breakfast-assam',
    name: 'Breakfast Assam (Pot)',
    sellPrice: 4.3,
    category: 'drinks',
    description: 'Malty, brisk and bright Assam tea.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-darjeeling-green',
    name: 'Darjeeling Green Tea (Pot)',
    sellPrice: 4.4,
    category: 'drinks',
    description: 'Finest tea grown organically on the rolling hills of Darjeeling.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-fresh-mint-tea',
    name: 'Fresh Mint Tea (Pot)',
    sellPrice: 4.3,
    category: 'drinks',
    description: 'A spearmint steeper to cleanse the palate.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-ginger-lemon-honey-tea',
    name: 'Ginger, Lemon & Honey Tea (Pot)',
    sellPrice: 4.3,
    category: 'drinks',
    description: 'Fresh vigour and increased joie-de-vivre.',
    allergensContains: [],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-haldi-doodh',
    name: 'Haldi Doodh',
    sellPrice: 4.8,
    category: 'drinks',
    description: "Turmeric, black pepper and jaggery frothed milk. Nani’s golden remedy.",
    allergensContains: ['milk'],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-espresso-single',
    name: 'Espresso (Single)',
    sellPrice: 4.0,
    category: 'drinks',
    description: 'Baba’s coffee — single shot. Smooth notes of milk chocolate, orange and jaggery.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-espresso-double',
    name: 'Espresso (Double)',
    sellPrice: 4.6,
    category: 'drinks',
    description: 'Baba’s coffee — double shot.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
  {
    id: 'dishoom-cappuccino-flat-white',
    name: 'Cappuccino, Caffelatte or Flat White',
    sellPrice: 4.7,
    category: 'drinks',
    description: 'Baba’s coffee. Kindly ask for oat milk if desired.',
    allergensContains: ['milk'],
    dietary: ['vegetarian'],
  },
  {
    id: 'dishoom-guest-brew',
    name: 'Guest Brew',
    sellPrice: 4.3,
    category: 'drinks',
    description: 'Finest grade guest filter coffees — hot or iced. Consult your server.',
    allergensContains: [],
    dietary: ['vegan', 'vegetarian'],
  },
];

function admin() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function resolveOrgId(supabase: ReturnType<typeof admin>): Promise<string> {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', DEMO_KITCHEN_ORG_ID)
    .maybeSingle();
  if (error) throw new Error(`org lookup: ${error.message}`);
  if (!data?.id) throw new Error(`Org not found: ${DEMO_KITCHEN_ORG_ID} (${ORG_NAME})`);
  console.log(`[dishoom] Org ${data.id} (${data.name})`);
  return data.id;
}

async function main() {
  const ids = new Set(MENU.map((m) => m.id));
  if (ids.size !== MENU.length) {
    throw new Error(`Duplicate menu ids: ${MENU.length} items, ${ids.size} unique`);
  }

  const supabase = admin();
  const orgId = await resolveOrgId(supabase);

  console.log(`[dishoom] Deleting existing products for org…`);
  const { error: delErr, count } = await supabase
    .from('products')
    .delete({ count: 'exact' })
    .eq('org_id', orgId);
  if (delErr) throw new Error(`delete products: ${delErr.message}`);
  console.log(`[dishoom] Deleted ${count ?? '?'} existing product rows`);

  const now = new Date().toISOString();
  const rows = MENU.map((item) => ({
    id: item.id,
    org_id: orgId,
    data: {
      name: item.name,
      image: '',
      basePrice: item.sellPrice,
      margin: 0,
      sellPrice: item.sellPrice,
      price: item.sellPrice,
      source: 'restaurant',
      category: item.category,
      tradeId: null,
      available: true,
      description: item.description ?? '',
      allergensContains: item.allergensContains ?? [],
      allergensMayContain: item.allergensMayContain ?? [],
      dietary: item.dietary ?? [],
      allergenNotes: ALLERGEN_NOTES,
      allergenDeclared: true,
    },
    updated_at: now,
  }));

  const { error: upErr } = await supabase.from('products').upsert(rows, { onConflict: 'org_id,id' });
  if (upErr) throw new Error(`products upsert: ${upErr.message}`);

  const byCat: Record<string, number> = {};
  for (const item of MENU) {
    byCat[item.category] = (byCat[item.category] ?? 0) + 1;
  }
  console.log(`[dishoom] Upserted ${rows.length} menu items:`);
  for (const [cat, n] of Object.entries(byCat).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${cat}: ${n}`);
  }
  console.log('[dishoom] Done.');
}

main().catch((err) => {
  console.error('[dishoom] FAILED', err);
  process.exit(1);
});
