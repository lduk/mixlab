# Separacja AI w MixLab

## Jak rozdzielić nagranie

Wybierz klip na osi i otwórz **Opcje klipu → Rozdziel na ścieżki AI**. Kliknięcie klipu prawym przyciskiem myszy prowadzi do tych samych opcji. Aby rozdzielić fragment, najpierw przeciągnij po dużej fali we właściwościach klipu. Okno potwierdzenia pokazuje zakres w czasie źródłowym oraz rozmiar modelu. Pierwsze użycie pobiera 66 759 214 bajtów wag i około 24,2 MB silnika. Wszystkie pliki aplikacji pochodzą z tego samego hostingu. Dźwięk pozostaje na urządzeniu.

Po zatwierdzeniu możesz dalej używać edytora. Pasek pokazuje liczbę pobranych bajtów, a później liczbę ukończonych segmentów. Inicjalizacja i pojedyncze wywołanie sieci neuronowej mają nieznany czas trwania. **Anuluj separację** przerywa worker. Oba gotowe wyniki trafiają na nowe ścieżki w jednym kroku historii. Oryginał zostaje wyciszony. Przy wyborze fragmentu części przed nim i po nim nadal grają. Cofnięcie operacji przywraca poprzedni stan.

Każdy wynik ma własną falę, głośność, Mute, Solo, tempo, przycięcie, krzywe głośności, filtr i eksport WAV lub MP3. Solo dotyczy miksu i jego eksportu. Eksport pojedynczego klipu zapisuje wybrany materiał, również gdy klip jest wyciszony w miksie. We właściwościach grupy **Start grupy** przesuwa wszystkie jej klipy, a **Pomnóż tempo grupy** skaluje prędkości oraz odstępy od wspólnego początku. 125% mnoży aktualne tempa przez 1,25. Czynności obejmują również zachowany oryginał. Nałożone przed separacją przejścia źródłowe są odtwarzane według ustawień z chwili podziału.

## Model i licencje

| Rozwiązanie | Co sprawdziliśmy | Zastosowanie |
|---|---|---|
| [web-audio-separation](https://github.com/incidentist/web-audio-separation/tree/d412f5a45e34bf73883516b7fcc4561c95c028bf) | Implementacja MDX w przeglądarce, parametry modelu i transformacje STFT/iSTFT. Kod MIT, osobna licencja PFFFT. | Dołączone lokalnie transformacje PFFFT. MixLab odpowiada za podział na segmenty, inferencję, cache i integrację z edytorem. |
| [sdemux](https://github.com/joverval/sdemux/tree/28b42ea28623d26def5651c14453ca9bbc374a61) | Cztery wyjścia HTDemucs, model ONNX 172 MB, WASM. README oznacza kod jako MIT. | Punkt odniesienia dla kolejnego etapu. Ten pakiet wag wymaga osobnej weryfikacji przed integracją. |
| [Demucs](https://github.com/facebookresearch/demucs/tree/e976d93ecc3865e5757426930257e200846a520a) | Referencyjna implementacja PyTorch na licencji MIT, modele czteroźródłowe i wariant sześciu instrumentów. | Kandydat do testów wieloźródłowych. |
| [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html) | Wersja 1.23.2, MIT i dołączone informacje o komponentach zewnętrznych. | Lokalna sesja w dedykowanym workerze. Próba WebGPU na dostępnym adapterze, ponowienie przez WASM SIMD w razie błędu. |

Wagi **UVR_MDXNET_Main.onnx** przygotował zespół Ultimate Vocal Remover. Autorzy wyraźnie obejmują wykorzystanie swoich modeli licencją MIT z uznaniem autorstwa. Dla tych wag konfiguracja UVR określa wyjście jako **Vocals**, rozmiar FFT 7680, 3072 pasma i współczynnik 1,043. ONNX przewiduje widmo wokalu. Po syntezie PCM i przywróceniu poziomu MixLab odejmuje wokal od sygnału wejściowego, uzyskując komplementarny podkład. [Licencja i autorzy UVR](https://github.com/Anjok07/ultimatevocalremovergui/blob/a5f88453bfb2b38b05a965bcf67727243e0cbf19/README.md#license) · [Konfiguracja UVR](https://github.com/Anjok07/ultimatevocalremovergui/blob/a5f88453bfb2b38b05a965bcf67727243e0cbf19/models/MDX_Net_Models/model_data/model_data.json) · [Oficjalne wagi](https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models) · [Dołączone licencje](../site/vendor/stems-licenses/)

## Przetwarzanie i pamięć

- Web Audio wybiera wskazany zakres i przelicza go do stereo 44,1 kHz. Worker wykonuje STFT, inferencję, iSTFT, mieszanie okien i obliczanie skrótów. Jedno okno modelu obejmuje 261 120 próbek, krok to 228 352 próbki, zakładka ma 32 768 próbek. Brzegi zakresu dostają kontekst zerowy. Sąsiednie przewidywania są łączone komplementarnymi wagami cosinusowymi w środkowej połowie zakładki.
- Oryginał w pamięci edytora zachowuje częstotliwość sesji. Wyniki mają 44,1 kHz. Suma surowych stemów odtwarza wejście po konwersji. Funkcje zachowania tonacji działają osobno dla każdego instrumentu i mogą wprowadzać różnice fazowe po zmianie tempa.
- Wagi są weryfikowane przez SHA-256 przy pobraniu i odczycie z cache. Cache Storage przechowuje również wynik modelu, identyfikowany przez SHA-256 obu kanałów wejścia, wersję modelu i sposób łączenia segmentów. Ponowne wczytanie identycznego materiału pozwala odtworzyć wynik, także po odświeżeniu karty. Układ projektu pozostaje w pamięci sesji. Usunięcie danych witryny usuwa wagi i zapisane wyniki. W trybie prywatnym lub po wyczerpaniu miejsca wynik może być dostępny tylko w sesji.
- Przeglądarka musi udostępniać HTTPS lub localhost, Web Audio, modułowe workery, Web Crypto i WebAssembly SIMD. GitHub Pages nie wymaga nagłówków izolacji między źródłami. WASM pracuje jednowątkowo. Pamięć operacyjna potrzebna na model i bufory znacznie przekracza rozmiar pobieranych plików.
- Budżety ochronne tej wersji to 90 s dla urządzeń zgłaszających 2–4 GB RAM i 600 s dla pozostałych. Przy zgłoszeniu poniżej 2 GB separacja jest niedostępna. Odczyt RAM jest przybliżony i część przeglądarek go nie udostępnia. Bieżąca ilość wolnej pamięci i ograniczenia pojedynczej karty mogą wymusić krótszy fragment.
- Każdy klip ma identyfikator grupy i rolę źródła (wokal, podkład, oryginał lub część poza zaznaczeniem). Istniejący mechanizm przejść operuje na pojedynczych klipach. Przyszły automat może wybierać pary oraz krzywe według ról.

## Pomiary PoC

Chromium 156.0.8078.79 na Linuksie x86-64, CPU z limitem czterech rdzeni, ONNX Runtime Web 1.23.2, brak adaptera WebGPU. Trzy fragmenty testowe MUSDB18-7. Każdy trwał 6,803 s i przecinał granicę segmentów. Wejście stanowiła suma dostarczonych referencji wokalu, perkusji, basu i pozostałych instrumentów po dekodowaniu FFmpeg. SDR liczony bez przeskalowania to 10 log₁₀(energia referencji / energia błędu). Poprawa jest liczona względem użycia całego miksu jako estymaty danego źródła. [Zestaw testowy](https://github.com/sigsep/sigsep-mus-db/releases/tag/v0.4.0)

| Próbka | SDR wokalu / poprawa | SDR podkładu / poprawa | Czas workera | RSS przed / maksimum |
|---|---:|---:|---:|---:|
| Cristina Vane – So Easy | 17,38 / +22,38 dB | 22,38 / +17,38 dB | 84,4 s | 568 / 1958 MiB |
| Louis Cressy Band – Good Time | 11,89 / +17,90 dB | 17,90 / +11,89 dB | 75,9 s | 680 / 1968 MiB |
| Secretariat – Borderline | 10,18 / +12,71 dB | 12,71 / +10,18 dB | 81,1 s | 691 / 1980 MiB |

Maksymalny błąd sumy wokalu i podkładu wyniósł 2,98 × 10⁻⁸ w skali PCM. Czasy obejmują inicjalizację, dwa wywołania modelu i zapis cache. Pierwsza próbka pobierała model z lokalnego serwera HTTP. RSS to suma procesów przeglądarki próbkowana co 100 ms, więc pamięć współdzielona może być liczona kilkukrotnie. Pomiar produkcyjny obejmie również czas pierwszego pobrania przez internet. Wyniki opisują te trzy nagrania. Pogłos, chórki i barwy podobne do wokalu mogą przenikać między ścieżkami.

Test edytora z rzeczywistą inferencją w Chromium objął anulowanie podczas separacji, edycję zaznaczenia, zgodność początków i tempa stemów, filtry, Solo, eksport WAV/MP3, cofnięcie oraz ponowne wykorzystanie cache po przeładowaniu. Test jakości porównuje sygnały numerycznie. Ocena odsłuchowa na szerszym repertuarze i pomiary na fizycznych telefonach pozostają otwarte. Ze względu na koszt czasowy i pamięć moduł udostępnia obecnie tryb dwóch ścieżek. [Testy przeglądarek](https://github.com/lduk/mixlab/actions/workflows/stem-browsers.yml)

## Odtworzenie testów

Uruchom z katalogu repozytorium:

```sh
bash scripts/prepare-stems.sh
python3 -m http.server 8213 --directory site
```

Drugi terminal, środowisko z Pythonem oraz FFmpeg na PATH:

```sh
python -m pip install playwright numpy psutil
python -m playwright install chromium
python tests/stem_editor.py
python tests/separation.py /ścieżka/do/MUSDB18-7-STEMS.zip
```

Parametr `--executable` pozwala wskazać systemowe Chromium. Oba testy obsługują `--browser firefox`. Benchmark domyślnie mierzy WASM. Opcja `--gpu` pozwala wybrać WebGPU, a pole `backend` pokazuje faktyczny wybór sesji. Dla Androida test edytora przyjmuje `--cdp http://127.0.0.1:9222` po udostępnieniu portu Chrome przez ADB i przekierowaniu portu 8213 do hosta. Pliki MUSDB18 nie są częścią aplikacji.
