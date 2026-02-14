import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChessPage } from './chess.page';

describe('ChessPage', () => {
  let component: ChessPage;
  let fixture: ComponentFixture<ChessPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(ChessPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
