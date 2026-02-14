import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { NgIf } from '@angular/common';
import { SplashComponent } from '../splash/splash.component';
@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: true,
  imports: [IonContent, NgIf, SplashComponent],
})
export class HomePage {
  showSplash = true;
  loading = false;
  currentPieceIndex = 0;
  quotes = [
    "Queens get the job done 👑♟️",
    "Protect the king, slay with style ✨",
    "Knights move funny, but deadly 🤺",
    "Check yourself before you get wrecked ✅",
    "Pawns today, queens tomorrow 🔥",
    "One wrong move = instant L 😭",
    "No cap, strategy wins games 🧠",
    "You can't win if you quit 🏆",
    "You can't lose if you don't play 🏆",
    "You can't win if you don't play 🏆"
  ];
  currentQuote = "";
  pieces = [
    '/assets/wq.png',
    '/assets/wn.png',
    '/assets/wb.png'
  ];
  private pieceInterval: any;

  constructor(private router: Router) { }

  ngOnInit() {
    setTimeout(() => {
      this.showSplash = false;
    }, 2000);
  }

  startGame() {
    this.loading = true;
    this.currentQuote = this.quotes[
      Math.floor(Math.random() * this.quotes.length)
    ];

    this.startLoaderAnimation();

    setTimeout(() => {
      this.stopLoaderAnimation();
      this.loading = false;
      this.router.navigate(['/chess']);
    }, 3000);
  }


  private startLoaderAnimation() {
    let bounceCount = 0;
    this.pieceInterval = setInterval(() => {
      this.currentPieceIndex = (this.currentPieceIndex + 1) % this.pieces.length;
      bounceCount++;

      if (bounceCount >= 3) {
        clearInterval(this.pieceInterval);
      }
    }, 1000); // every bounce = 1s
  }

  private stopLoaderAnimation() {
    if (this.pieceInterval) {
      clearInterval(this.pieceInterval);
      this.pieceInterval = null;
    }
  }
}