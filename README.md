# MixLab

Lokalny edytor nagrań działający w przeglądarce. Uruchom w katalogu projektu:

```sh
python3 scripts/serve.py
```

Otwórz port 8213 w przeglądarce. Do publikacji wystarcza zawartość katalogu `site/`. Workflow w `.github/workflows/pages.yml` publikuje ten katalog po wysłaniu zmian na `main`. Odświeżenie strony usuwa sesję edytora. Pobrane wagi AI i wyniki separacji mogą pozostać w lokalnym cache witryny.

## Separacja wokalu i podkładu

Wybierz klip i otwórz **Opcje klipu → Rozdziel na ścieżki AI**. Możesz rozdzielić cały klip lub fragment zaznaczony na jego fali. W domyślnym wdrożeniu Pages wagi i silnik są gotowe do pobrania na żądanie. Przy uruchamianiu lokalnym przygotuj je jednorazowo poleceniem `bash scripts/prepare-stems.sh`. [Instrukcja, licencje, ograniczenia i pomiary](docs/separacja-ai.md)

## Montaż

- Kliknij podziałkę, a następnie **＋ Efekty**. Przycisk **▶** pozwala odsłuchać dźwięk, a **Dodaj** wstawia go na osobnej ścieżce w miejscu kursora. Efekty są syntetyzowane w przeglądarce i można je edytować oraz eksportować tak jak nagrania.

- Dodaj nagrania. Każdy import tworzy osobną ścieżkę. Przeciągaj tytuł klipu wzdłuż osi lub na inną ścieżkę. Przyciąganie wyrównuje brzegi do innych klipów.
- Przeciągnij po fali i kliknij **Przytnij zaznaczenie**, aby zostawić wybrany fragment w jego miejscu na osi. Krawędzie fali służą do przycinania i odzyskiwania materiału. Uchwyt **↔** przy tytule zmienia tempo.
- Przeciągnij różowy punkt wejścia lub wyjścia, aby ustawić długość narastania albo wyciszania. Kliknięcie punktu przełącza jego krzywą między liniową i Equal Power. Przycisk **⋯** prowadzi do opcji klipu.
- Pasek każdego klipu pokazuje tempo w miksie. Podczas importu aplikacja próbuje oszacować BPM. Przyciski **−** i **+** zmieniają tempo o 1 BPM. Przy nieznanym BPM pasek pokazuje prędkość w procentach, a krok wynosi 1 punkt procentowy. **Wycisz** na pasku wyłącza dźwięk klipu w odsłuchu i eksporcie. **Włącz** przywraca ustawiony poziom. Suwak **Głośność** po prawej stronie przycisku wyciszenia reguluje klip od 0 do 100% także podczas odtwarzania. Liczba obok suwaka pokazuje bieżące ustawienie.
- Każdy klip ma własne BPM źródłowe. Wpisz je lub kliknij **Oszacuj BPM**, aby przeanalizować puls w środkowym fragmencie nagrania (do 30 sekund, zakres 60–200 BPM). Przy słabym pulsie lub zmiennym tempie wynik wymaga oceny. Ustawienie źródła opisuje nagranie. Wpisanie BPM docelowego zmienia prędkość i długość klipu.
- Na tej samej ścieżce nałożenie klipów włącza przejście. Fioletowy obszar i obwiednia na fali pokazują jego długość i poziom sygnału. Właściwości **wchodzącego klipu** określają typ i czas przejścia. Puste pole obejmuje całe nałożenie. Krótszy czas kończy przejście wcześniej. Osobne ścieżki sumują dźwięk.
- Suwak **Zoom** obejmuje zakres od 1× do 4096× w skali logarytmicznej. Ustaw kursor w interesującym miejscu przed powiększeniem. Przy dużym zbliżeniu fala pokazuje przebieg z próbek nagrania, a przy odpowiednim odstępie także punkty próbek.
- Drobne kreski dzielą odstępy między opisami czasu. Najedź na oś lub ścieżkę, aby zobaczyć czas w formacie minuty:sekundy.milisekundy i przerywaną linię przez ścieżki.
- Kliknij falę, wolne miejsce na ścieżce lub podziałkę, aby ustawić początek odtwarzania albo miejsce podziału wybranego klipu. Przeciągnięcie po podziałce ustawia zakres i włącza pętlę. Odtwórz miks, aby go zapętlić. Eksport zawsze obejmuje cały miks.
- Cofnij i ponów obsługują ostatnie 30 edycji. WAV i MP3 uwzględniają tempo, głośność i wszystkie przejścia.

## Przetwarzanie i ograniczenia

`site/app.js` przechowuje operacje edycyjne i rysuje oś czasu. Klipy odwołują się do źródłowych buforów Web Audio. Moduł `site/audio.js` przygotowuje zmianę tempa i wspólny graf odsłuchu oraz eksportu. Zachowanie tonacji używa SoundTouchJS 0.2.1. Przy dużej zmianie tempa możliwe są artefakty. Zapas poziomu jest obliczany na podstawie sumy głośności jednoczesnych klipów i stosowany w całym miksie.

Pierwszy odsłuch po zmianie tempa wymaga przygotowania próbek. Pętla renderuje zaznaczony zakres do bufora. Limit długości projektu zależy od pamięci urządzenia. MP3 koduje osobny worker z lamejs 1.2.1. Obie biblioteki są dostarczane lokalnie z licencjami w `site/vendor/`.

## Testy

Przy działającym serwerze na porcie 8213 uruchom `python3 tests/editor.py` w środowisku z pakietem Python Playwright i Chromium w `/usr/bin/chromium`. Test generuje dwa sygnały, mierzy długość i częstotliwość po zmianie tempa, porównuje eksport miksu i przejścia oraz ćwiczy gesty, historię, pętlę i eksport MP3.
